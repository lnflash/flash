/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint @typescript-eslint/no-var-requires: "off" */

/**
 * Migration: unique index on accounts.npub
 *
 * Background
 * ----------
 * `npub` had neither an index nor a uniqueness constraint, and `setNpub` did no
 * duplicate checking — it wrote whatever the caller sent. `findByNpub` is a
 * `findOne`, so two accounts holding the same npub resolved to whichever
 * document Mongo scanned first. That became support-facing the moment
 * `accountDetailsByNpub` shipped: a support agent opening a DM from an npub
 * would see username / level / phone / email off an arbitrary one of the
 * colliding accounts.
 *
 * What this migration does
 * ------------------------
 * 1. Lowercases any non-lowercase npub. The old `findByNpub` carried a
 *    case-insensitive collation which has been dropped (bech32 is a
 *    lowercase-only charset, and the collation blocked index use), so stored
 *    values must be normalised or they stop being findable.
 * 2. Audits for duplicate npubs. When a group is found, npub is UNSET on EVERY
 *    account in it — including the oldest. Accounts are never deleted or
 *    merged here. Guessing an owner by created_at is worse than releasing the
 *    key: the oldest account is often an abandoned one left behind by a phone
 *    reset, while the live handset actually holding the nostr secret key is
 *    the newer account. Once the unique index exists, whoever re-links first
 *    wins, and the index makes that race safe. Every unset is logged with
 *    account id + npub so support can tell the owners to re-link from the app.
 * 3. Creates the unique partial index.
 *
 * `partialFilterExpression: { npub: { $type: "string" } }` rather than
 * `sparse: true`: a sparse index still indexes documents holding an explicit
 * `npub: null`, and the second such document would collide.
 *
 * Rollback (down)
 * ---------------
 * Drops the unique index. The lowercasing and the unsets are NOT reverted —
 * they are data repairs, and restoring known-ambiguous npubs would reintroduce
 * the identity collision.
 *
 * Manual recovery
 * ---------------
 * `setNpub` refuses an npub already held by another account
 * (`NpubNotAvailableError`) and the admin API exposes no mutation that can
 * unset or reassign one. So if an npub ends up on the wrong account, the only
 * way to free it is a hand-written write against mongo:
 *
 *   db.accounts.updateOne({ id: "<accountUuid>" }, { $unset: { npub: "" } })
 *
 * After that, the rightful owner re-links from the app.
 */

const COLLECTION = "accounts"
const INDEX_NAME = "npub_1"

module.exports = {
  async up(db) {
    const col = db.collection(COLLECTION)

    const exists = await db.listCollections({ name: COLLECTION }).toArray()
    if (exists.length === 0) {
      // Fresh database (this is what CI's clean-migration run sees).
      // createIndex creates the collection, and there is nothing to repair.
      await col.createIndex(
        { npub: 1 },
        {
          unique: true,
          name: INDEX_NAME,
          partialFilterExpression: { npub: { $type: "string" } },
        },
      )
      console.log(`[migration] ${COLLECTION} did not exist; created "${INDEX_NAME}".`)
      return
    }

    // ── Step 1: normalise case ───────────────────────────────────────────────
    // Server-side, so this does not stream the collection through the migration
    // process. The ids are listed first purely so the repair is auditable.
    const mixedCase = await col
      .aggregate(
        [
          { $match: { npub: { $type: "string" } } },
          { $match: { $expr: { $ne: ["$npub", { $toLower: "$npub" }] } } },
          { $project: { _id: 1, id: 1, npub: 1 } },
        ],
        { allowDiskUse: true },
      )
      .toArray()

    for (const doc of mixedCase) {
      console.log(`[migration] accountId=${doc.id} npub will be lowercased: ${doc.npub}`)
    }

    if (mixedCase.length > 0) {
      // Scoped to the ids just collected. Filtering on `{ npub: { $type:
      // "string" } }` instead would rewrite every npub-bearing account —
      // oplog churn and index re-touching during the deploy window for zero
      // additional repairs.
      await col.updateMany({ _id: { $in: mixedCase.map((d) => d._id) } }, [
        { $set: { npub: { $toLower: "$npub" } } },
      ])
    }
    console.log(`[migration] Normalised ${mixedCase.length} npub value(s) to lowercase.`)

    // ── Step 2: find and release duplicate npub groups ───────────────────────
    // Only the fields needed for the audit log are pushed — `$$ROOT` would risk
    // the 16MB per-group limit on a large accounts collection.
    const duplicates = await col
      .aggregate(
        [
          { $match: { npub: { $type: "string" } } },
          {
            $group: {
              _id: "$npub",
              count: { $sum: 1 },
              docs: { $push: { _id: "$_id", id: "$id", created_at: "$created_at" } },
            },
          },
          { $match: { count: { $gt: 1 } } },
        ],
        { allowDiskUse: true },
      )
      .toArray()

    if (duplicates.length > 0) {
      console.log(
        `[migration] Found ${duplicates.length} npub(s) claimed by more than one account. Releasing...`,
      )

      for (const group of duplicates) {
        // Every account in the group loses the npub, including the oldest.
        // There is no way to tell from mongo which account still holds the
        // nostr secret key, and picking wrong is unrecoverable in-product:
        // `setNpub` refuses an already-claimed npub and no admin mutation can
        // release one. Releasing the key lets the real owner re-link from the
        // app; the unique index makes the re-link race safe.
        const ids = group.docs.map((d) => d._id)

        console.log(
          `[migration] npub=${group._id} — releasing from ${ids.length} account(s): ${group.docs
            .map((d) => `${d.id} (_id=${d._id}, created_at=${d.created_at})`)
            .join(", ")}`,
        )

        await col.updateMany({ _id: { $in: ids } }, { $unset: { npub: "" } })
      }

      console.log(
        "[migration] Duplicate npub release complete. Affected owners must re-link from the app.",
      )
    } else {
      console.log("[migration] No duplicate npub values found. Proceeding.")
    }

    // ── Step 3: drop any stale index, then create the unique partial index ───
    const existingIndexes = await col.indexes()
    const stale = existingIndexes.find((idx) => idx.name === INDEX_NAME && !idx.unique)
    if (stale) {
      await col.dropIndex(INDEX_NAME)
      console.log(`[migration] Dropped existing non-unique index "${INDEX_NAME}".`)
    }

    await col.createIndex(
      { npub: 1 },
      {
        unique: true,
        name: INDEX_NAME,
        partialFilterExpression: { npub: { $type: "string" } },
      },
    )
    console.log(`[migration] Created unique index "${INDEX_NAME}" on ${COLLECTION}.`)
  },

  async down(db) {
    const col = db.collection(COLLECTION)

    const exists = await db.listCollections({ name: COLLECTION }).toArray()
    if (exists.length === 0) return

    const existingIndexes = await col.indexes()
    const hasUniqueIndex = existingIndexes.some(
      (idx) => idx.name === INDEX_NAME && idx.unique,
    )
    if (hasUniqueIndex) {
      await col.dropIndex(INDEX_NAME)
      console.log(`[migration] Dropped unique index "${INDEX_NAME}".`)
    }
  },
}
