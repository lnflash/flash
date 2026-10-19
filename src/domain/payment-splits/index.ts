export * from "./errors"
export * from "./compute-share"
export * from "./validate"

// ENG-717: one payout leg of a settled receive. A share leg pays an enabled
// rule's percentage; the net leg pays the merchant the remainder (rounding
// dust, and any share folded for being below minShareCents, go to the net).
export type SplitLegKind = "share" | "net"

export const InternalTransferOrigin = {
  Intraledger: "intraledger",
  Cutover: "cutover",
  // A Flash user paid a bolt11 (QR scan). Marked before paying, whether or
  // not the payee turns out to be a Flash wallet.
  LnSend: "ln-send",
  // A Flash user paid a Lightning address / LNURL. IBEX fetches the invoice
  // itself, so the hash is only known (and marked) after the payment returns.
  LnurlSend: "lnurl-send",
  // A split payout leg: the shadow receive account pays a destination (or the
  // merchant's net). Marked before paying, like any Flash-minted invoice, so
  // the destination's own splits never fire on it.
  Split: "split",
} as const

export type InternalTransferOrigin =
  (typeof InternalTransferOrigin)[keyof typeof InternalTransferOrigin]

// Backoff before attempt n+1 after the nth failed attempt: 1, 2, 4, 8, 16 min.
export const splitRetryBackoffMs = (failedAttempts: number): number =>
  60_000 * 2 ** Math.max(0, failedAttempts - 1)

// Extra lookback on top of a reconcile's run cadence, so a receive that landed
// just before the previous run (or while one run was late) is still read.
const RECONCILE_MIN_MARGIN_MS = 10 * 60_000

/**
 * Lookback for a split reconcile that runs every `cadenceMs`. Always longer
 * than the cadence, so consecutive runs overlap and no receive falls in a gap:
 * a 15-minute loop reads 25 minutes, the daily cron reads 26 hours.
 */
export const splitReconcileWindowMs = (cadenceMs: number): number =>
  cadenceMs + Math.max(RECONCILE_MIN_MARGIN_MS, Math.ceil(cadenceMs / 12))
