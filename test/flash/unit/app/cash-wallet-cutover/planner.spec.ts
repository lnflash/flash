import { buildPrimaryCashWalletMigrationPlan } from "@app/cash-wallet-cutover/planner"

const discovery = (
  status: CashWalletCutoverDiscoveryStatus,
  accountId: AccountId,
): CashWalletCutoverDiscovery => ({
  status,
  accountId,
  accountUuid: `${accountId}-uuid` as AccountUuid,
  legacyUsdWalletId: `${accountId}-usd` as WalletId,
  destinationUsdtWalletId: `${accountId}-usdt` as WalletId,
  previousDefaultWalletId: `${accountId}-default` as WalletId,
})

describe("primary cash wallet migration planner", () => {
  it("creates deterministic migration plans for legacy-default accounts only", () => {
    const result = buildPrimaryCashWalletMigrationPlan({
      cutoverVersion: 4,
      runId: "run-4",
      discoveries: [
        discovery("legacy_default", "account-1" as AccountId),
        discovery("already_usdt", "account-2" as AccountId),
        discovery("residual_legacy_usd", "account-3" as AccountId),
        discovery("legacy_default", "account-4" as AccountId),
      ],
    })

    expect(result).toEqual([
      {
        accountId: "account-1",
        accountUuid: "account-1-uuid",
        legacyUsdWalletId: "account-1-usd",
        destinationUsdtWalletId: "account-1-usdt",
        previousDefaultWalletId: "account-1-default",
        cutoverVersion: 4,
        runId: "run-4",
        idempotencyKey: "cash-wallet-cutover:run-4:account-1",
      },
      {
        accountId: "account-4",
        accountUuid: "account-4-uuid",
        legacyUsdWalletId: "account-4-usd",
        destinationUsdtWalletId: "account-4-usdt",
        previousDefaultWalletId: "account-4-default",
        cutoverVersion: 4,
        runId: "run-4",
        idempotencyKey: "cash-wallet-cutover:run-4:account-4",
      },
    ])
  })
})
