/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint @typescript-eslint/no-var-requires: "off" */

/**
 * Migration: indexes for the gift card orders collection (ENG-579)
 *
 * Background
 * ----------
 * `giftcardorders` is new with the gift card provider feature. One document per
 * purchase attempt; `status` moves through a fixed state machine via
 * conditional updates (`src/services/mongoose/gift-card-orders.ts`). Three of
 * the indexes below are correctness constraints, not just read paths:
 *
 *  - `walletId_1_idempotencyKey_1` (unique): a client retry or two concurrent
 *    purchases with the same idempotency key must produce ONE order. The
 *    repository maps the E11000 on this index to
 *    `GiftCardOrderDuplicateKeyError` so the app layer returns the existing
 *    order instead of failing.
 *  - `providerId_1_providerOrderId_1` (unique, partial): one vendor order maps
 *    to one Flash order, so a vendor webhook or poll can never be attributed to
 *    two orders. `partialFilterExpression: { providerOrderId: { $type:
 *    "string" } }` rather than `sparse: true`: a sparse compound index still
 *    indexes a document when ANY of its keys is present, and `providerId`
 *    always is — so the second order still awaiting a vendor id
 *    (`providerOrderId: null`) would collide.
 *  - `id_1` (unique): `id` is our own UUID and the only id the API ever shows.
 *
 * The two remaining indexes serve the account history page
 * (`accountId_1_createdAt_-1`) and the reconciler's stale-order sweep
 * (`status_1_updatedAt_1`).
 *
 * Key specs and options here match `GiftCardOrderSchema` in
 * `src/services/mongoose/schema.ts` exactly, so `syncIndexes()` on boot sees
 * nothing to drop or rebuild.
 *
 * Rollout
 * -------
 * New collection, so there is no duplicate data to repair and no ordering
 * hazard beyond the usual one: the migrate Job runs before any pod on the new
 * image boots (see 20260824120000-accounts-unique-npub for the full story).
 * Idempotent: an existing index with the same name and spec is left alone; one
 * with the same name but a different spec is dropped and recreated.
 *
 * Rollback (down)
 * ---------------
 * Drops the five indexes by name. Documents are kept — orders are financial
 * records and must survive a rollback.
 */

const COLLECTION = "giftcardorders"

const INDEXES = [
  { keys: { id: 1 }, options: { name: "id_1", unique: true } },
  {
    keys: { accountId: 1, createdAt: -1 },
    options: { name: "accountId_1_createdAt_-1" },
  },
  {
    keys: { providerId: 1, providerOrderId: 1 },
    options: {
      name: "providerId_1_providerOrderId_1",
      unique: true,
      partialFilterExpression: { providerOrderId: { $type: "string" } },
    },
  },
  { keys: { status: 1, updatedAt: 1 }, options: { name: "status_1_updatedAt_1" } },
  {
    keys: { walletId: 1, idempotencyKey: 1 },
    options: { name: "walletId_1_idempotencyKey_1", unique: true },
  },
]

const sameSpec = (existing, desired) =>
  JSON.stringify(existing.key) === JSON.stringify(desired.keys) &&
  Boolean(existing.unique) === Boolean(desired.options.unique) &&
  JSON.stringify(existing.partialFilterExpression ?? null) ===
    JSON.stringify(desired.options.partialFilterExpression ?? null)

module.exports = {
  async up(db) {
    const col = db.collection(COLLECTION)

    const exists = await db.listCollections({ name: COLLECTION }).toArray()
    const existingIndexes = exists.length === 0 ? [] : await col.indexes()

    for (const desired of INDEXES) {
      const current = existingIndexes.find((idx) => idx.name === desired.options.name)
      if (current && sameSpec(current, desired)) {
        console.log(
          `[migration] ${COLLECTION}.${desired.options.name} already up to date.`,
        )
        continue
      }
      if (current) {
        await col.dropIndex(desired.options.name)
        console.log(
          `[migration] Dropped ${COLLECTION}.${desired.options.name} (spec differed).`,
        )
      }
      await col.createIndex(desired.keys, desired.options)
      console.log(`[migration] Created ${COLLECTION}.${desired.options.name}.`)
    }
  },

  async down(db) {
    const col = db.collection(COLLECTION)

    const exists = await db.listCollections({ name: COLLECTION }).toArray()
    if (exists.length === 0) return

    const existingIndexes = await col.indexes()
    for (const desired of INDEXES) {
      if (existingIndexes.some((idx) => idx.name === desired.options.name)) {
        await col.dropIndex(desired.options.name)
        console.log(`[migration] Dropped ${COLLECTION}.${desired.options.name}.`)
      }
    }
  },
}
