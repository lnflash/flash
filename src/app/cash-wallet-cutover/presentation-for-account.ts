import { WalletsRepository, CashWalletCutoverRepository } from "@services/mongoose"
// Type-only: the real reader is loaded lazily below. A static import would
// construct the IBEX client (and its Redis connection) as a module side
// effect, dragging live connections into every consumer of the presentation
// path — including its unit tests.
import type { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import { ErrorLevel, WalletCurrency } from "@domain/shared"
import { recordExceptionInCurrentSpan } from "@services/tracing"

import { CashWalletClientCapabilities } from "./client-capability"
import {
  CashWalletCutoverPreflightError,
  CashWalletMissingUsdtWalletError,
} from "./errors"
import { ensureUsdtWalletForAccount as ensureUsdtWallet } from "./ensure-usdt-wallet"
import { evaluateCashWalletCutoverPresentation } from "./guard"
import {
  CashWalletPresentationResult,
  resolveCashWalletPresentation,
} from "./presentation"

type CashWalletPresentationMigrationsRepository = {
  getConfig: () => Promise<CashWalletCutoverConfig | RepositoryError>
  findMigrationByAccountId: ({
    accountId,
    cutoverVersion,
    runId,
  }: {
    accountId: AccountId
    cutoverVersion: number
    runId: string
  }) => Promise<CashWalletMigration | RepositoryError | null>
}

type CashWalletPresentationWalletsRepository = {
  listByAccountId: (accountId: AccountId) => Promise<Wallet[] | RepositoryError>
  // Optional: injected repos that also carry persistNew (e.g. the real
  // WalletsRepository) get the self-heal's create routed through them too;
  // list-only repos fall back to the real repo for the create.
  persistNew?: (args: NewWalletInfo) => Promise<Wallet | ApplicationError>
}

const defaultLegacyUsdBalance: typeof getBalanceForWallet = async (args) =>
  (await import("@app/wallets/get-balance-for-wallet")).getBalanceForWallet(args)

export const resolveCashWalletPresentationForAccount = async ({
  account,
  client,
  migrationsRepo = CashWalletCutoverRepository(),
  walletsRepo = WalletsRepository(),
  legacyUsdBalance = defaultLegacyUsdBalance,
}: {
  account: Account
  client: CashWalletClientCapabilities
  migrationsRepo?: CashWalletPresentationMigrationsRepository
  walletsRepo?: CashWalletPresentationWalletsRepository
  // Injected for the same reason the repos are — and defaulted to the real
  // IBEX-backed reader, whose 404/absent-balance cases already map to ZERO
  // (drained and never-funded accounts read as zero, which is the fleet this
  // heal exists for).
  legacyUsdBalance?: typeof getBalanceForWallet
}): Promise<CashWalletPresentationResult | ApplicationError> => {
  const cutover = await migrationsRepo.getConfig()
  if (cutover instanceof Error) return cutover

  let migration: CashWalletMigration | null | undefined
  if (cutover.state === "in_progress") {
    if (!cutover.runId) return new CashWalletCutoverPreflightError()

    const foundMigration = await migrationsRepo.findMigrationByAccountId({
      accountId: account.id,
      cutoverVersion: cutover.cutoverVersion,
      runId: cutover.runId,
    })
    if (foundMigration instanceof Error) return foundMigration
    migration = foundMigration
  }

  const decision = evaluateCashWalletCutoverPresentation({
    cutover,
    migration,
    client,
  })
  if (decision instanceof Error) return decision

  const wallets = await walletsRepo.listByAccountId(account.id)
  if (wallets instanceof Error) return wallets

  const presentation = resolveCashWalletPresentation({ decision, wallets })

  // ENG-544 self-heal. Accounts predating the cutover can lack the USDT
  // wallet the decision demands, which used to surface as
  // CashWalletMissingUsdtWalletError on EVERY usdt-presentation path —
  // including accountDefaultWallet, i.e. lightning-address resolution, so
  // those accounts could not be paid at all. Converge the account here, once,
  // under an account-scoped lock (see ensureUsdtWalletForAccount), and resolve
  // against the healed wallet list. On creation failure this falls through to
  // the original error: the account is no better off, but never worse, and the
  // next resolution retries.
  if (presentation instanceof CashWalletMissingUsdtWalletError) {
    // BALANCE GATE, and it is the load-bearing safety of this heal. The
    // "usdt" presentation HIDES the legacy USD wallet: its balance resolver
    // redirects legacy-wallet queries to the settlement wallet (usd-wallet.ts)
    // — a design that assumes migration MOVED the funds first. These accounts
    // are unmigrated (the missing wallet is exactly what blocked their
    // migration: discovery status `missing_destination_usdt`), so healing one
    // that still holds a legacy balance would flip its app to an empty USDT
    // view with the money out of sight. Funds intact on the ledger, invisible
    // to the customer — worse than the dead address this fixes.
    //
    // So: under the "usdt" presentation, heal only when the legacy wallet is
    // absent or reads zero. A failed balance read also skips — creating blind
    // is exactly the flip this gate exists to prevent — and the next
    // resolution retries. Skipped accounts keep the original error and stay
    // on the operator queue (discovery still flags them); moving their money
    // is a migration run, not a lazy write on the resolution path.
    //
    // `legacy_usd_compat` heals unconditionally: that presentation keeps the
    // legacy wallet visible AND default (presentation.ts), so a balance hides
    // nothing — it is the designed mid-migration state.
    if (decision.presentation === "usdt") {
      const legacyUsdWallet = wallets.find(
        (wallet) => wallet.currency === WalletCurrency.Usd,
      )
      if (legacyUsdWallet) {
        const balance = await legacyUsdBalance({
          walletId: legacyUsdWallet.id,
          currency: WalletCurrency.Usd,
        })
        if (balance instanceof Error || !balance.isZero()) {
          recordExceptionInCurrentSpan({
            error:
              balance instanceof Error
                ? balance
                : new CashWalletMissingUsdtWalletError(
                    "heal skipped: legacy USD balance is nonzero — account needs migration, not lazy wallet creation",
                  ),
            level: ErrorLevel.Warn,
            attributes: {
              accountId: account.id,
              ensureUsdtWallet:
                balance instanceof Error
                  ? "skipped_balance_unreadable"
                  : "skipped_nonzero_legacy_balance",
            },
          })
          return presentation
        }
      }
    }

    const created = await ensureUsdtWallet({ account, walletsRepo })
    if (created) {
      return resolveCashWalletPresentation({ decision, wallets: [...wallets, created] })
    }
  }

  return presentation
}

export const resolveCashWalletMutationWalletIdForAccount = async ({
  account,
  walletId,
  client,
  migrationsRepo,
  walletsRepo,
}: {
  account: Account
  walletId: WalletId
  client: CashWalletClientCapabilities
  migrationsRepo?: CashWalletPresentationMigrationsRepository
  walletsRepo?: CashWalletPresentationWalletsRepository
}): Promise<WalletId | ApplicationError> => {
  const presentation = await resolveCashWalletPresentationForAccount({
    account,
    client,
    migrationsRepo,
    walletsRepo,
  })
  if (presentation instanceof Error) return presentation

  if (walletId === presentation.legacyUsdWallet?.id) {
    return presentation.activeSettlementWallet.id
  }

  return walletId
}
