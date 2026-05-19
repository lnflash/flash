import {
  CashWalletCutoverInProgressError,
  CashWalletMigrationFailedError,
  evaluateCashWalletCutoverGuard,
} from "@app/cash-wallet-cutover/guard"

const config = (state: CashWalletCutoverState): CashWalletCutoverConfig => ({
  state,
  cutoverVersion: 2,
  runId: "run-2",
  updatedAt: new Date("2026-05-19T00:00:00Z"),
})

const migration = (status: CashWalletMigrationStatus): CashWalletMigration => ({
  id: "migration-id",
  accountId: "account-id" as AccountId,
  legacyUsdWalletId: "usd-wallet-id" as WalletId,
  destinationUsdtWalletId: "usdt-wallet-id" as WalletId,
  cutoverVersion: 2,
  runId: "run-2",
  status,
  idempotencyKey: "run-2:account-id",
  attempts: 0,
  updatedAt: new Date("2026-05-19T00:00:00Z"),
})

describe("cash wallet cutover guard", () => {
  it("allows legacy route before cutover starts", () => {
    expect(evaluateCashWalletCutoverGuard({ cutover: config("pre") })).toEqual({
      route: "legacy_usd",
    })
  })

  it("allows legacy route during cutover before this account starts", () => {
    expect(evaluateCashWalletCutoverGuard({ cutover: config("in_progress") })).toEqual({
      route: "legacy_usd",
    })
    expect(
      evaluateCashWalletCutoverGuard({
        cutover: config("in_progress"),
        migration: migration("not_started"),
      }),
    ).toEqual({ route: "legacy_usd" })
  })

  it("rejects writes while this account is actively migrating", () => {
    for (const status of [
      "balance_read",
      "balance_move_sending",
      "fee_reimbursement_sending",
    ] as const) {
      expect(
        evaluateCashWalletCutoverGuard({
          cutover: config("in_progress"),
          migration: migration(status),
        }),
      ).toBeInstanceOf(CashWalletCutoverInProgressError)
    }
  })

  it("routes completed accounts to ETH-USDT during cutover", () => {
    expect(
      evaluateCashWalletCutoverGuard({
        cutover: config("in_progress"),
        migration: migration("complete"),
      }),
    ).toEqual({ route: "eth_usdt" })
  })

  it("rejects failed and manual-review migrations", () => {
    for (const status of ["failed", "requires_operator_review"] as const) {
      expect(
        evaluateCashWalletCutoverGuard({
          cutover: config("in_progress"),
          migration: migration(status),
        }),
      ).toBeInstanceOf(CashWalletMigrationFailedError)
    }
  })

  it("routes all accounts to ETH-USDT after global completion", () => {
    expect(evaluateCashWalletCutoverGuard({ cutover: config("complete") })).toEqual({
      route: "eth_usdt",
    })
  })
})
