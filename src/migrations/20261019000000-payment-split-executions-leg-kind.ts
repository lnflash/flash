/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint @typescript-eslint/no-var-requires: "off" */

/**
 * Migration: payment splits v2 (ENG-717) execution-schema change
 *
 * Background
 * ----------
 * ENG-717 replaces v1's hold-and-forward splits (ENG-653) with settle-on-a-
 * shadow-receive-account and immediate fanout. Two collection changes:
 *
 * 1. `paymentsplitexecutions` gains `legKind` ("share" | "net") and drops the
 *    v1 `skipped_min` / `skipped_internal` statuses (a sub-min share now folds
 *    into the net leg instead of being recorded as skipped). The unique index
 *    moves from (triggerKey, walletId, destinationWalletId) to
 *    (triggerKey, legKind, destinationWalletId) — the net leg and a share leg
 *    may share a destination wallet on the same receive, and the fold row
 *    (decision 2) keys as a share leg to the merchant, distinct from the
 *    settle-time net row by legKind.
 * 2. New collection `splitreceiveaccounts`, one shadow receive account per
 *    wallet, unique on walletId and on ibexAccountId.
 *
 * v1 rows are all terminal in prod (every split since 10/13 has settled or
 * failed terminally; `pending` rows would be stale beyond the executor's
 * retry window), so no data migration is performed: old rows simply do not
 * match the new executor's queries in a way that could pay twice —
 * `claimNextDue` matches status "pending", and no v1 row is re-claimable once
 * its index entry is superseded. Old rows keep their documents; the new index
 * accepts them (their legKind field is absent → null, unique per trigger).
 *
 * Rollout
 * -------
 * THIS MIGRATION MUST COMPLETE BEFORE ANY POD RUNNING THE NEW IMAGE BOOTS
 * (the chart's wait-for-mongodb-migrate initContainer enforces the ordering
 * the same way it does for every galoy workload). `schema.ts` declares the
 * new indexes; a `syncIndexes()` boot against a collection still carrying the
 * old unique index would conflict with the new one on existing documents
 * whose legKind is absent — actually it would not (different key sets), but
 * the OLD index would then reject the new net rows (same triggerKey, same
 * walletId, same destination as the share leg) with E11000, so the migrate
 * Job must have dropped it first.
 *
 * Rollback (down)
 * ---------------
 * Recreates the v1 unique index and drops the v2 one, and drops
 * `splitreceiveaccounts` ONLY if it is empty (a non-empty one means v2
 * already minted shadows; dropping them would orphan real IBEX accounts —
 * those are permanent by decision 4 and are left in place, the collection
 * too).
 */

const EXECUTIONS = "paymentsplitexecutions"
const OLD_INDEX = "triggerKey_1_walletId_1_destinationWalletId_1"
const NEW_INDEX = "triggerKey_1_legKind_1_destinationWalletId_1"
const SHADOWS = "splitreceiveaccounts"

module.exports = {
  async up(db) {
    const col = db.collection(EXECUTIONS)

    const exists = await db.listCollections({ name: EXECUTIONS }).toArray()
    if (exists.length > 0) {
      const old = await col.indexes()
      if (old.some((i) => i.name === OLD_INDEX)) {
        await col.dropIndex(OLD_INDEX)
        console.log(`[migration] ${EXECUTIONS}: dropped "${OLD_INDEX}"`)
      }
    }

    // createIndex is idempotent (same name + same keys = no-op). The
    // partialFilterExpression keeps absent-legKind documents (v1 rows) out of
    // the unique key space, so they cannot collide with each other.
    await col.createIndex(
      { triggerKey: 1, legKind: 1, destinationWalletId: 1 },
      {
        unique: true,
        name: NEW_INDEX,
        partialFilterExpression: { legKind: { $type: "string" } },
      },
    )
    console.log(`[migration] ${EXECUTIONS}: created "${NEW_INDEX}"`)

    // The shadows collection itself needs no migration — its indexes are
    // created by syncIndexes() at boot — but creating them here makes the
    // first walletSplitsSet not race two unique-index creations.
    await db
      .collection(SHADOWS)
      .createIndex({ walletId: 1 }, { unique: true, name: "walletId_1" })
    await db
      .collection(SHADOWS)
      .createIndex({ ibexAccountId: 1 }, { unique: true, name: "ibexAccountId_1" })
    console.log(`[migration] ${SHADOWS}: indexes ensured`)
  },

  async down(db) {
    const col = db.collection(EXECUTIONS)
    const current = await col.indexes()
    if (current.some((i) => i.name === NEW_INDEX)) {
      await col.dropIndex(NEW_INDEX)
    }
    await col.createIndex(
      { triggerKey: 1, walletId: 1, destinationWalletId: 1 },
      { unique: true, name: OLD_INDEX },
    )

    const shadowsEmpty =
      !(await db.listCollections({ name: SHADOWS }).toArray()).length ||
      (await db.collection(SHADOWS).countDocuments()) === 0
    if (shadowsEmpty) {
      await db.collection(SHADOWS).drop()
      console.log(`[migration] ${SHADOWS}: dropped (was empty)`)
    } else {
      console.log(
        `[migration] ${SHADOWS}: NOT dropped — holds created shadow accounts (permanent by ENG-717 decision 4)`,
      )
    }
  },
}
