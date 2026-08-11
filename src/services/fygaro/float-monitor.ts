import { FygaroConfig } from "@config"
import { USDAmount, USDTAmount } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { baseLogger } from "@services/logger"
import { redis } from "@services/redis"

import {
  FygaroCreditError,
  resolveFygaroTreasuryFundingWallet,
} from "./webhook-server/credit-topup"

/**
 * Proactive bankowner treasury float check (the main value of the float-
 * monitoring work). Auto-credit sends card top-ups from the bankowner treasury;
 * if that float quietly drains, every subsequent credit fails one-at-a-time. A
 * periodic check that pages BEFORE the well runs dry turns that into a single
 * "top up soon" heads-up instead of a stream of exhausted-credit incidents.
 *
 * Contract: this is registered as a cron task and MUST NOT throw — a thrown
 * task fails the whole cron run (exit 99 -> CrashLoopBackOff). Every failure
 * path here logs and returns. Only runs when the fygaro feature is enabled AND
 * auto-credit is on: during the record-only phase (fygaro.enabled=true,
 * credit.enabled=false) nothing ever spends from the treasury, so paging "top
 * up bankowner" would be premature noise that contradicts its own instruction.
 */
const DEFAULT_FLOOR_USD = 2000

// Cross-run rate limit for the float-low warning. alertBridge's own TTL dedup
// is a process-local Map, but this monitor runs as a one-shot cron Job (a fresh
// process every ~15-min run), so that dedup resets each run and cannot suppress
// anything across runs. Without this a treasury sitting below the floor would
// page every run (~4/hr) instead of the ~1/hr the alert layer implies. A Redis
// NX marker with a 1h TTL gives real cross-run suppression that survives the
// process restarts. A Redis error falls through to alerting: over-notifying is
// the safe failure mode for a draining float, never staying silent.
const FLOAT_LOW_ALERT_WINDOW_SECONDS = 3600
const FLOAT_LOW_ALERT_MARKER = "fygaro:float-low:alerted"

const claimFloatLowAlertSlot = async (): Promise<boolean> => {
  try {
    const set = await redis.set(
      FLOAT_LOW_ALERT_MARKER,
      "1",
      "EX",
      FLOAT_LOW_ALERT_WINDOW_SECONDS,
      "NX",
    )
    return set === "OK"
  } catch (err) {
    baseLogger.warn(
      { err },
      "Fygaro float check: dedup marker unavailable, alerting anyway",
    )
    return true
  }
}

export const checkFygaroTreasuryFloat = async (): Promise<void> => {
  // Gate on both the feature flag and the auto-credit master gate. With
  // credit.enabled=false the webhook only records payments and the treasury ->
  // user transfer stays manual, so there is nothing for this monitor to fund
  // yet — running it would page every window over a float no credit touches.
  if (!FygaroConfig.enabled || !FygaroConfig.credit?.enabled) return

  const floorUsd = FygaroConfig.float?.floorUsd ?? DEFAULT_FLOOR_USD

  try {
    // Read the balance of the SAME wallet auto-credit actually spends from —
    // resolved through the shared resolver credit-topup uses — so the monitored
    // account is provably the funding source. In flash's IBEX-custodial model
    // each walletId is its own IBEX account, so reading the bankowner account's
    // default wallet would read a DIFFERENT account's balance (typically the USD
    // wallet) and mis-parse it as the USDT float: a drained USDT float would
    // hide behind a funded USD wallet (no page ever fires) and a low USD wallet
    // would false-alarm as "USDT float low".
    const funding = await resolveFygaroTreasuryFundingWallet()
    if (funding instanceof FygaroCreditError) {
      // Could not resolve the treasury or its funding wallet. Log and bail; the
      // next run re-reads. Never alert here (a distinct alert would fight the
      // float-low dedup) and never crash the cron.
      baseLogger.error(
        { step: funding.step, detail: funding.message },
        "Fygaro float check: could not resolve the bankowner treasury funding wallet",
      )
      return
    }

    const fundingWallet = funding.fundingWallet
    const details = await Ibex.getAccountDetails(fundingWallet.id, fundingWallet.currency)

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
      // Rate-limit across cron runs via the Redis marker (see above); without
      // it a persistent low float would page every ~15-min run.
      if (await claimFloatLowAlertSlot()) {
        alertBridge({
          dedupKey: generateDedupKey.fygaroFloatLow(),
          source: "fygaro-webhook",
          severity: "warning",
          title: "Fygaro treasury float low — top up bankowner",
          detail: `balance=$${balanceUsd.toFixed(2)} floor=$${floorUsd.toFixed(2)}`,
          context: { balance_usd: balanceUsd, floor_usd: floorUsd },
        })
      }
    }
  } catch (err) {
    // Belt-and-suspenders: a resolver throw or any unexpected error is
    // swallowed so the cron run still succeeds.
    baseLogger.error({ err }, "Fygaro float check errored")
  }
}
