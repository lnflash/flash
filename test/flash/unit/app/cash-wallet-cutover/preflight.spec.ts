import { buildCashWalletCutoverPreflightReport } from "@app/cash-wallet-cutover/preflight"

const discovery = (
  status: CashWalletCutoverDiscoveryStatus,
  accountId = `${status}-account` as AccountId,
): CashWalletCutoverDiscovery => ({
  status,
  accountId,
  accountUuid: `${accountId}-uuid` as AccountUuid,
  legacyUsdWalletId:
    status === "missing_legacy_usd" ? undefined : (`${accountId}-usd` as WalletId),
  destinationUsdtWalletId:
    status === "missing_destination_usdt" ? undefined : (`${accountId}-usdt` as WalletId),
  previousDefaultWalletId: `${accountId}-default` as WalletId,
})

describe("cash wallet cutover preflight report", () => {
  it("counts migration candidates and non-migrating classifications", () => {
    const report = buildCashWalletCutoverPreflightReport({
      cutoverVersion: 3,
      runId: "run-3",
      discoveries: [
        discovery("legacy_default", "legacy-1" as AccountId),
        discovery("legacy_default", "legacy-2" as AccountId),
        discovery("already_usdt"),
        discovery("residual_legacy_usd"),
        discovery("missing_legacy_usd"),
        discovery("missing_destination_usdt"),
      ],
    })

    expect(report).toMatchObject({
      cutoverVersion: 3,
      runId: "run-3",
      totalAccounts: 6,
      migrationCandidates: 2,
      alreadyUsdt: 1,
      residualLegacyUsd: 1,
      blockers: 2,
      canStart: false,
    })
    expect(report.blockerAccounts).toEqual([
      { accountId: "missing_legacy_usd-account", reason: "missing_legacy_usd" },
      {
        accountId: "missing_destination_usdt-account",
        reason: "missing_destination_usdt",
      },
    ])
  })

  it("allows start when every account is either migratable, already migrated, or residual", () => {
    const report = buildCashWalletCutoverPreflightReport({
      cutoverVersion: 3,
      runId: "run-3",
      discoveries: [
        discovery("legacy_default"),
        discovery("already_usdt"),
        discovery("residual_legacy_usd"),
      ],
    })

    expect(report.canStart).toBe(true)
    expect(report.blockerAccounts).toEqual([])
  })
})
