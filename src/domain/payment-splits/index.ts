export * from "./errors"
export * from "./compute-share"
export * from "./validate"

export const PaymentSplitExecutionStatus = {
  Pending: "pending",
  Sending: "sending",
  Sent: "sent",
  IbexPending: "ibex_pending",
  Failed: "failed",
  SkippedMin: "skipped_min",
  Unknown: "unknown",
} as const

export type PaymentSplitExecutionStatus =
  (typeof PaymentSplitExecutionStatus)[keyof typeof PaymentSplitExecutionStatus]

export const InternalTransferOrigin = {
  Intraledger: "intraledger",
  Cutover: "cutover",
} as const

export type InternalTransferOrigin =
  (typeof InternalTransferOrigin)[keyof typeof InternalTransferOrigin]

// Backoff before attempt n+1 after the nth failed attempt: 1, 2, 4, 8, 16 min.
export const splitRetryBackoffMs = (failedAttempts: number): number =>
  60_000 * 2 ** Math.max(0, failedAttempts - 1)
