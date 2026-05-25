import { CashWalletCutoverDiscovery } from "./discovery"

type CashWalletCutoverPreflightBlocker = {
  accountId: AccountId
  reason: "missing_legacy_usd" | "missing_destination_usdt"
}

type CashWalletCutoverPreflightReport = {
  cutoverVersion: number
  runId: string
  totalAccounts: number
  migrationCandidates: number
  alreadyUsdt: number
  residualLegacyUsd: number
  blockers: number
  blockerAccounts: CashWalletCutoverPreflightBlocker[]
  canStart: boolean
}

export type { CashWalletCutoverPreflightReport }

export const buildCashWalletCutoverPreflightReport = ({
  cutoverVersion,
  runId,
  discoveries,
}: {
  cutoverVersion: number
  runId: string
  discoveries: CashWalletCutoverDiscovery[]
}): CashWalletCutoverPreflightReport => {
  const blockerAccounts = discoveries.flatMap(({ accountId, status }) => {
    if (status !== "missing_legacy_usd" && status !== "missing_destination_usdt") {
      return []
    }

    return [{ accountId, reason: status }]
  })

  return {
    cutoverVersion,
    runId,
    totalAccounts: discoveries.length,
    migrationCandidates: discoveries.filter(({ status }) => status === "legacy_default")
      .length,
    alreadyUsdt: discoveries.filter(({ status }) => status === "already_usdt").length,
    residualLegacyUsd: discoveries.filter(
      ({ status }) => status === "residual_legacy_usd",
    ).length,
    blockers: blockerAccounts.length,
    blockerAccounts,
    canStart: blockerAccounts.length === 0,
  }
}
