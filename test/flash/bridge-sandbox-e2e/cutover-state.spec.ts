/**
 * Bridge Sandbox E2E — Post-Cutover State Assertions
 *
 * Verifies the system-wide cash wallet cutover state via the public
 * `cashWalletCutover` query, and optionally validates that accounts
 * see correct wallet routing after cutover.
 *
 * The cutover state is a system-wide singleton (not per-account) stored in
 * the CashWalletCutoverConfig collection.
 *
 * This spec is guarded by SKIP_CUTOVER_TESTS — it only runs actively when
 * CUTOVER_TESTS=true is set, since sandbox environments may not have
 * cutover infrastructure seeded.
 *
 * Verified shapes (from source audit of `cashWalletCutover.ts`, `lifecycle.ts`):
 *   - cashWalletCutover query (public) returns CashWalletCutoverObject:
 *     { state: CashWalletCutoverState!, scheduledAt, startedAt,
 *       completedAt, pausedAt, pauseReason, cutoverVersion: Int!,
 *       runId, updatedBy, updatedAt: Timestamp! }
 *   - Valid states: "not_started", "started", "provisioned", "balance_read",
 *     "invoice_created", "balance_move_sending", "balance_move_sent",
 *     "balance_move_verified", "fee_reimbursement_invoice_created",
 *     "fee_reimbursement_sending", "fee_reimbursed", "pointer_flipped",
 *     "legacy_zero_verified", "complete", "failed", "requires_operator_review",
 *     "skipped_already_migrated", "rollback_started", "rolled_back"
 */

const CUTOVER_TESTS = process.env.CUTOVER_TESTS === "true"

;(CUTOVER_TESTS ? describe : describe.skip)("Post-Cutover State", () => {
  describe("System-wide cutover config query", () => {
    // The cutover query doesn't use auth context, but
    // execQuery requires an accountId for context building.
    const dummyAccountId = `acct_cutover_test_${Date.now()}`

    it("returns cashWalletCutover with expected shape", async () => {
      const { execQuery } = await import("./helpers")

      const source = `
        query CashWalletCutover {
          cashWalletCutover {
            state
            cutoverVersion
            runId
            scheduledAt
            startedAt
            completedAt
            pausedAt
            pauseReason
            updatedAt
            updatedBy
          }
        }
      `

      const response = await execQuery<{
        cashWalletCutover: { state: string; cutoverVersion: number; updatedAt: string }
      }>(source, dummyAccountId)
      if ("errors" in response) throw new Error(JSON.stringify(response.errors))

      expect(response.cashWalletCutover).toBeDefined()
      expect(typeof response.cashWalletCutover.state).toBe("string")
      expect(response.cashWalletCutover.cutoverVersion).toEqual(expect.any(Number))
      expect(typeof response.cashWalletCutover.updatedAt).toBe("string")
    })

    it("state is a valid cutover state enum value", async () => {
      const { execQuery } = await import("./helpers")

      const VALID_STATES = new Set([
        "not_started",
        "started",
        "provisioned",
        "balance_read",
        "invoice_created",
        "balance_move_sending",
        "balance_move_sent",
        "balance_move_verified",
        "fee_reimbursement_invoice_created",
        "fee_reimbursement_sending",
        "fee_reimbursed",
        "pointer_flipped",
        "legacy_zero_verified",
        "complete",
        "failed",
        "requires_operator_review",
        "skipped_already_migrated",
        "rollback_started",
        "rolled_back",
      ])

      const source = `
        query CashWalletCutover {
          cashWalletCutover {
            state
          }
        }
      `

      const response = await execQuery<{
        cashWalletCutover: { state: string }
      }>(source, dummyAccountId)
      if ("errors" in response) throw new Error(JSON.stringify(response.errors))

      expect(VALID_STATES.has(response.cashWalletCutover?.state)).toBe(true)
    })
  })
})
