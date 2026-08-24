import { WalletType } from "@domain/wallets"
import { ErrorLevel, WalletCurrency } from "@domain/shared"
import { LockService } from "@services/lock"
import { WalletsRepository } from "@services/mongoose"
import { recordExceptionInCurrentSpan } from "@services/tracing"

type EnsureWalletsRepository = {
  listByAccountId: (accountId: AccountId) => Promise<Wallet[] | RepositoryError>
  persistNew: (args: NewWalletInfo) => Promise<Wallet | RepositoryError>
}

/**
 * Create the USDT cash wallet an account should already have, exactly once.
 *
 * Exists for ENG-544: accounts predating the cutover that never got a USDT
 * wallet hit `CashWalletMissingUsdtWalletError` in every presentation-"usdt"
 * path — including `accountDefaultWallet`, which is what lightning-address
 * resolution calls, so those accounts simply could not be paid. The decision
 * (Jabari, 2026-08-24) is to converge the account to the cutover target on
 * first touch rather than route funds into a wallet being retired.
 *
 * The cares, in order of importance:
 *
 * - This runs on an effectively UNAUTHENTICATED read path (anyone can resolve
 *   a lightning address), so creation must be strictly idempotent. The
 *   account-scoped redlock is what makes two concurrent resolutions of the
 *   same cold address mint ONE wallet: the loser of the race re-lists inside
 *   the lock and finds the winner's wallet. `persistNew` alone is not
 *   idempotent — it creates a fresh IBEX account every call.
 * - Creation failure DEGRADES to the status quo, never worse: the caller gets
 *   `null` and falls through to the same missing-wallet error the account had
 *   before this existed. A failed IBEX call must not take down a resolution
 *   path that at least errored consistently.
 * - The lock failing (Redis blip) is treated as creation failure, not as
 *   permission to create without it. Unlocked creation is exactly the
 *   double-mint this function exists to prevent, and the next resolution will
 *   simply try again.
 */
export const ensureUsdtWalletForAccount = async ({
  account,
  walletsRepo = WalletsRepository(),
}: {
  account: Account
  walletsRepo?: EnsureWalletsRepository
}): Promise<Wallet | null> => {
  const created = await LockService().lockAccountId(account.id, async () => {
    // Re-check INSIDE the lock: the concurrent resolution that beat us to the
    // lock has already created the wallet, and finding it here is the whole
    // point of locking before creating.
    const wallets = await walletsRepo.listByAccountId(account.id)
    if (wallets instanceof Error) return wallets

    const existing = wallets.find((wallet) => wallet.currency === WalletCurrency.Usdt)
    if (existing) return existing

    return walletsRepo.persistNew({
      accountId: account.id,
      type: WalletType.Checking,
      currency: WalletCurrency.Usdt,
    })
  })

  if (created instanceof Error) {
    recordExceptionInCurrentSpan({
      error: created,
      level: ErrorLevel.Warn,
      attributes: { accountId: account.id, ensureUsdtWallet: "failed" },
    })
    return null
  }

  return created
}
