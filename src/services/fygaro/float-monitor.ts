import { FygaroConfig } from "@config"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import Ibex from "@services/ibex/client"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { baseLogger } from "@services/logger"

/**
 * Proactive bankowner treasury float check (the main value of the float-
 * monitoring work). Auto-credit sends card top-ups from the bankowner treasury;
 * if that float quietly drains, every subsequent credit fails one-at-a-time. A
 * periodic check that pages BEFORE the well runs dry turns that into a single
 * "top up soon" heads-up instead of a stream of exhausted-credit incidents.
 *
 * Contract: this is registered as a cron task and MUST NOT throw — a thrown
 * task fails the whole cron run (exit 99 -> CrashLoopBackOff). Every failure
 * path here logs and returns. Only runs when the fygaro feature is enabled so
 * an unconfigured instance never alerts.
 */
const DEFAULT_FLOOR_USD = 2000

// The role whose account funds auto-credit sends (credit-topup.ts).
const TREASURY_ROLE = "bankowner"

export const checkFygaroTreasuryFloat = async (): Promise<void> => {
  if (!FygaroConfig.enabled) return

  const floorUsd = FygaroConfig.float?.floorUsd ?? DEFAULT_FLOOR_USD

  try {
    // Read the balance of the SAME wallet auto-credit actually spends from —
    // resolved exactly the way credit-topup.ts does — so the monitored account
    // is provably the funding source. In flash's IBEX-custodial model each
    // walletId is its own IBEX account, so reading the bankowner account's
    // default wallet would read a DIFFERENT account's balance (typically the USD
    // wallet) and mis-parse it as the USDT float: a drained USDT float would
    // hide behind a funded USD wallet (no page ever fires) and a low USD wallet
    // would false-alarm as "USDT float low".
    const treasury = await AccountsRepository().findByRole(TREASURY_ROLE)
    if (treasury instanceof Error) {
      baseLogger.error(
        { err: treasury, role: TREASURY_ROLE },
        "Fygaro float check: could not resolve the bankowner treasury account",
      )
      return
    }

    const wallets = await WalletsRepository().listByAccountId(treasury.id)
    if (wallets instanceof Error) {
      baseLogger.error(
        { err: wallets },
        "Fygaro float check: could not list bankowner treasury wallets",
      )
      return
    }

    // Prefer the USDT wallet (the active cash wallet), falling back to the
    // legacy USD wallet — the exact selection credit-topup makes for the send.
    const funding =
      wallets.find((w) => w.currency === WalletCurrency.Usdt) ??
      wallets.find((w) => w.currency === WalletCurrency.Usd)
    if (!funding) {
      baseLogger.error(
        { role: TREASURY_ROLE },
        "Fygaro float check: treasury account has no USDT or USD wallet",
      )
      return
    }

    const details = await Ibex.getAccountDetails(funding.id, funding.currency)

    if (details instanceof Error) {
      // An IBEX read blip must never crash the cron, and must never be mistaken
      // for a low balance. Log and bail; the next run re-reads. (Per the "or
      // logs" option — a distinct alert here would fight the float-low dedup.)
      baseLogger.error(
        { err: details },
        "Fygaro float check: could not read bankowner treasury balance",
      )
      return
    }

    // IBEX omits `balance` for a drained / never-funded account (absent means
    // zero — see get-balance-for-wallet.ts). A genuinely empty treasury reads
    // as 0 here and correctly trips the floor. Read the balance in the funding
    // wallet's own currency so the USD fallback is not scored as an empty USDT
    // float (or vice versa).
    const balance = details.balance
    const balanceUsd =
      balance instanceof USDTAmount
        ? Number(balance.asNumber())
        : balance instanceof USDAmount
          ? Number(balance.asDollars())
          : 0

    if (balanceUsd < floorUsd) {
      baseLogger.warn({ balanceUsd, floorUsd }, "Fygaro treasury float below floor")
      alertBridge({
        dedupKey: generateDedupKey.fygaroFloatLow(),
        source: "fygaro-webhook",
        severity: "warning",
        title: "Fygaro treasury float low — top up bankowner",
        detail: `balance=$${balanceUsd.toFixed(2)} floor=$${floorUsd.toFixed(2)}`,
        context: { balance_usd: balanceUsd, floor_usd: floorUsd },
      })
    }
  } catch (err) {
    // Belt-and-suspenders: a resolver throw or any unexpected error is
    // swallowed so the cron run still succeeds.
    baseLogger.error({ err }, "Fygaro float check errored")
  }
}
