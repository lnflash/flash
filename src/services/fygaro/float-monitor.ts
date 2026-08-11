import { FygaroConfig } from "@config"
import { USDTAmount, WalletCurrency } from "@domain/shared"
import { getBankOwnerWalletId } from "@services/ledger/caching"
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

export const checkFygaroTreasuryFloat = async (): Promise<void> => {
  if (!FygaroConfig.enabled) return

  const floorUsd = FygaroConfig.float?.floorUsd ?? DEFAULT_FLOOR_USD

  try {
    // walletId IS the IBEX accountId (see docs/ledger caching). Read the
    // treasury's USDT balance straight off the IBEX client.
    const walletId = await getBankOwnerWalletId()
    const details = await Ibex.getAccountDetails(walletId, WalletCurrency.Usdt)

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
    // as 0 here and correctly trips the floor.
    const balanceUsd =
      details.balance instanceof USDTAmount ? Number(details.balance.asNumber()) : 0

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
