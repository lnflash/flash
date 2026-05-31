import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

import { discoverCashWalletCutoverAccounts } from "./discovery"
import { InvalidCashWalletCutoverStateTransitionError } from "./errors"
import {
  buildCashWalletCutoverPreflightReport,
  CashWalletCutoverPreflightReport,
} from "./preflight"

type ProvisionedCashWalletUsdtWallet = {
  accountId: AccountId
  walletId?: WalletId
}

type FailedCashWalletUsdtWalletProvision = {
  accountId: AccountId
  error: string
}

type ProvisionPrimaryCashWalletUsdtWalletsResult = {
  before: CashWalletCutoverPreflightReport
  after: CashWalletCutoverPreflightReport
  eligible: number
  provisioned: ProvisionedCashWalletUsdtWallet[]
  failed: FailedCashWalletUsdtWalletProvision[]
  dryRun: boolean
}

type CashWalletCutoverProvisioningRepository = {
  getConfig: () => Promise<CashWalletCutoverConfig | RepositoryError>
}

type AddWalletIfNonexistent = ({
  accountId,
  type,
  currency,
}: {
  accountId: AccountId
  type: WalletType
  currency: WalletCurrency
}) => Promise<Wallet | ApplicationError>

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs))

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

export type { ProvisionPrimaryCashWalletUsdtWalletsResult }

export const provisionPrimaryCashWalletUsdtWallets = async ({
  cutoverVersion,
  runId,
  accountsRepo,
  walletsRepo,
  migrationsRepo,
  addWalletIfNonexistent,
  provisionLimit,
  provisionDelayMs = 0,
  dryRun = false,
  sleep = defaultSleep,
}: {
  cutoverVersion: number
  runId: string
  accountsRepo: Pick<IAccountsRepository, "listUnlockedAccounts">
  walletsRepo: Pick<IWalletsRepository, "listByAccountId">
  migrationsRepo: CashWalletCutoverProvisioningRepository
  addWalletIfNonexistent: AddWalletIfNonexistent
  provisionLimit?: number
  provisionDelayMs?: number
  dryRun?: boolean
  sleep?: (delayMs: number) => Promise<void>
}): Promise<ProvisionPrimaryCashWalletUsdtWalletsResult | ApplicationError> => {
  const config = await migrationsRepo.getConfig()
  if (config instanceof Error) return config

  if (config.state !== "pre") {
    return new InvalidCashWalletCutoverStateTransitionError(
      "Cash wallet USDT provisioning can only run before cutover start",
    )
  }

  const discoveries = await discoverCashWalletCutoverAccounts({
    accountsRepo,
    walletsRepo,
  })
  if (discoveries instanceof Error) return discoveries

  const before = buildCashWalletCutoverPreflightReport({
    cutoverVersion,
    runId,
    discoveries,
  })

  const eligibleDiscoveries = discoveries
    .filter(({ status }) => status === "missing_destination_usdt")
    .slice(0, provisionLimit)
  const provisioned: ProvisionedCashWalletUsdtWallet[] = []
  const failed: FailedCashWalletUsdtWalletProvision[] = []

  if (!dryRun) {
    for (const [index, discovery] of eligibleDiscoveries.entries()) {
      const wallet = await addWalletIfNonexistent({
        accountId: discovery.accountId,
        type: WalletType.Checking,
        currency: WalletCurrency.Usdt,
      })

      if (wallet instanceof Error) {
        failed.push({ accountId: discovery.accountId, error: errorMessage(wallet) })
      } else {
        provisioned.push({ accountId: discovery.accountId, walletId: wallet.id })
      }

      if (provisionDelayMs > 0 && index < eligibleDiscoveries.length - 1) {
        await sleep(provisionDelayMs)
      }
    }
  }

  const afterDiscoveries = dryRun
    ? discoveries
    : await discoverCashWalletCutoverAccounts({ accountsRepo, walletsRepo })
  if (afterDiscoveries instanceof Error) return afterDiscoveries

  const after = buildCashWalletCutoverPreflightReport({
    cutoverVersion,
    runId,
    discoveries: afterDiscoveries,
  })

  return {
    before,
    after,
    eligible: eligibleDiscoveries.length,
    provisioned,
    failed,
    dryRun,
  }
}
