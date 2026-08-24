// Deliberately NOT the @app/accounts barrel: the barrel constructs
// repositories at module load, which drags the entire accounts module (and
// its side effects) into every consumer of the presentation path.
import { updateDefaultWalletId } from "@app/accounts/update-default-walletid"
import { WalletType } from "@domain/wallets"
import { ErrorLevel, WalletCurrency } from "@domain/shared"
import { LockService } from "@services/lock"
import { WalletsRepository } from "@services/mongoose"
import { recordExceptionInCurrentSpan } from "@services/tracing"

type EnsureWalletsRepository = {
  listByAccountId: (accountId: AccountId) => Promise<Wallet[] | RepositoryError>
  // Optional so list-only callers (e.g. the presentation resolver's injected
  // repo) can still route reads through their repo; creation falls back to
  // the real repo when absent.
  persistNew?: (args: NewWalletInfo) => Promise<Wallet | ApplicationError>
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
 * - Convergence includes the stored default pointer, mirroring the real
 *   migration path (runtime-services pairs addWalletIfNonexistent with
 *   updateDefaultWalletId). A healed account that keeps the RETIRED legacy
 *   USD wallet as its persisted default keeps getting balance notifications
 *   on it (send-default-wallet-balance-to-users), shows the wrong default on
 *   the operator dashboard, and gets re-flagged by discovery as still needing
 *   a pointer flip. The flip only happens when the stored default IS the
 *   legacy USD wallet — a deliberate non-cash default (e.g. BTC) is the
 *   user's choice and stays put.
 */
export const ensureUsdtWalletForAccount = async ({
  account,
  walletsRepo = WalletsRepository(),
  updateDefaultWallet = updateDefaultWalletId,
}: {
  account: Account
  walletsRepo?: EnsureWalletsRepository
  updateDefaultWallet?: typeof updateDefaultWalletId
}): Promise<Wallet | null> => {
  const created = await LockService().lockAccountId(account.id, async () => {
    // Re-check INSIDE the lock: the concurrent resolution that beat us to the
    // lock has already created the wallet, and finding it here is the whole
    // point of locking before creating.
    const wallets = await walletsRepo.listByAccountId(account.id)
    if (wallets instanceof Error) return wallets

    const persistNew = walletsRepo.persistNew ?? WalletsRepository().persistNew

    const existing = wallets.find((wallet) => wallet.currency === WalletCurrency.Usdt)
    const usdtWallet =
      existing ??
      (await persistNew({
        accountId: account.id,
        type: WalletType.Checking,
        currency: WalletCurrency.Usdt,
      }))
    if (usdtWallet instanceof Error) return usdtWallet

    const legacyUsdWallet = wallets.find(
      (wallet) => wallet.currency === WalletCurrency.Usd,
    )
    if (legacyUsdWallet && account.defaultWalletId === legacyUsdWallet.id) {
      const updated = await updateDefaultWallet({
        accountId: account.id,
        walletId: usdtWallet.id,
      })
      if (updated instanceof Error) {
        // The wallet exists and the caller can resolve against it — a failed
        // pointer flip must not undo the heal. The residual pointer is
        // exactly what discovery flags (status "legacy_default"), so the
        // operator flow picks it up.
        recordExceptionInCurrentSpan({
          error: updated,
          level: ErrorLevel.Warn,
          attributes: {
            accountId: account.id,
            ensureUsdtWallet: "default_wallet_flip_failed",
          },
        })
      }
    }

    return usdtWallet
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
