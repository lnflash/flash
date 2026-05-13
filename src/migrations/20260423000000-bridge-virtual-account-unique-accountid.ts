/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint @typescript-eslint/no-var-requires: "off" */

/**
 * Migration: unique index on bridgevirtualaccounts.accountId
 *
 * Background
 * ----------
 * BridgeService.createVirtualAccount now carries an idempotency guard that
 * uses a MongoDB upsert keyed on accountId. The upsert is only atomic against
 * concurrent writes if a unique index backs the filter field. Without it two
 * racing writes can both pass the findOneAndUpdate "find" phase, both insert,
 * and produce duplicate VAs for the same account.
 *
 * What this migration does
 * ------------------------
 * 1. Audits the collection for any existing accountId duplicates.
 * 2. For each duplicate group, keeps the oldest document (earliest createdAt)
 *    and removes the rest. Removed _ids are logged so they can be reconciled
 *    against Bridge if necessary.
 * 3. Drops any existing plain index on accountId (Mongoose created it as
 *    index:true before this change).
 * 4. Creates the new unique index { accountId: 1 }.
 *
 * Rollback (down)
 * ---------------
 * Drops the unique index and restores a plain index so the app schema stays
 * consistent with a pre-migration schema.ts.
 */

const COLLECTION = "bridgevirtualaccounts"
const INDEX_NAME = "accountId_1"

module.exports = {
  async up(db) {
    const col = db.collection(COLLECTION)

    // ── Step 1: find duplicate accountId groups ──────────────────────────────
    const duplicates = await col
      .aggregate([
        { $group: { _id: "$accountId", count: { $sum: 1 }, docs: { $push: "$$ROOT" } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray()

    if (duplicates.length > 0) {
      console.log(
        `[migration] Found ${duplicates.length} accountId(s) with duplicate VA records. Deduplicating...`,
      )

      for (const group of duplicates) {
        // Sort ascending by createdAt — keep the winner (index 0), remove the rest
        const sorted = group.docs.sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )
        const [winner, ...losers] = sorted
        const loserIds = losers.map((d) => d._id)

        console.log(
          `[migration] accountId=${group._id} — keeping _id=${winner._id} bridgeVAId=${winner.bridgeVirtualAccountId}, removing ${loserIds.length} duplicate(s): ${loserIds.join(", ")}`,
        )

        await col.deleteMany({ _id: { $in: loserIds } })
      }

      console.log("[migration] Deduplication complete.")
    } else {
      console.log("[migration] No duplicate accountId records found. Proceeding.")
    }

    // ── Step 2: drop stale plain index if it exists ──────────────────────────
    const existingIndexes = await col.indexes()
    const hasPlainIndex = existingIndexes.some(
      (idx) => idx.name === INDEX_NAME && !idx.unique,
    )
    if (hasPlainIndex) {
      await col.dropIndex(INDEX_NAME)
      console.log(`[migration] Dropped existing non-unique index "${INDEX_NAME}".`)
    }

    // ── Step 3: create unique index ──────────────────────────────────────────
    await col.createIndex({ accountId: 1 }, { unique: true, name: INDEX_NAME })
    console.log(`[migration] Created unique index "${INDEX_NAME}" on ${COLLECTION}.`)
  },

  async down(db) {
    const col = db.collection(COLLECTION)

    // Drop the unique index
    const existingIndexes = await col.indexes()
    const hasUniqueIndex = existingIndexes.some(
      (idx) => idx.name === INDEX_NAME && idx.unique,
    )
    if (hasUniqueIndex) {
      await col.dropIndex(INDEX_NAME)
      console.log(`[migration] Dropped unique index "${INDEX_NAME}".`)
    }

    // Restore plain index so Mongoose schema (pre-change) stays consistent
    await col.createIndex({ accountId: 1 }, { name: INDEX_NAME })
    console.log(`[migration] Restored plain index "${INDEX_NAME}" on ${COLLECTION}.`)
  },
}
