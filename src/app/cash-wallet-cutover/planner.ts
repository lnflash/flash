import { CashWalletCutoverDiscovery } from "./discovery"

type PrimaryCashWalletMigrationPlan = {
  accountId: AccountId
  accountUuid?: AccountUuid
  legacyUsdWalletId: WalletId
  destinationUsdtWalletId: WalletId
  previousDefaultWalletId: WalletId
  cutoverVersion: number
  runId: string
  idempotencyKey: string
}

export type { PrimaryCashWalletMigrationPlan }

export const buildPrimaryCashWalletMigrationPlan = ({
  cutoverVersion,
  runId,
  discoveries,
}: {
  cutoverVersion: number
  runId: string
  discoveries: CashWalletCutoverDiscovery[]
}): PrimaryCashWalletMigrationPlan[] =>
  discoveries.flatMap((discovery) => {
    if (discovery.status !== "legacy_default") return []
    if (!discovery.legacyUsdWalletId || !discovery.destinationUsdtWalletId) return []

    return [
      {
        accountId: discovery.accountId,
        accountUuid: discovery.accountUuid,
        legacyUsdWalletId: discovery.legacyUsdWalletId,
        destinationUsdtWalletId: discovery.destinationUsdtWalletId,
        previousDefaultWalletId: discovery.previousDefaultWalletId,
        cutoverVersion,
        runId,
        idempotencyKey: `cash-wallet-cutover:${runId}:${discovery.accountId}`,
      },
    ]
  })
