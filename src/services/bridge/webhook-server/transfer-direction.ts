/**
 * Distinguishes Bridge outbound withdrawals (USDT → ACH) from inbound deposits
 * when replaying status_transitioned events that share the same state names.
 */
export const isOutboundBridgeWithdrawal = (
  eventObject: Record<string, unknown> | undefined,
): boolean => {
  if (!eventObject) return false
  const source = eventObject.source as Record<string, unknown> | undefined
  const destination = eventObject.destination as Record<string, unknown> | undefined
  return source?.payment_rail === "ethereum" && destination?.payment_rail === "ach"
}

const OUTBOUND_WITHDRAWAL_REPLAY_STATUSES = new Set([
  "payment_processed",
  "undeliverable",
  "returned",
  "refunded",
  "refund_failed",
  "missing_return_policy",
  "error",
  "canceled",
])

export const transferReplayEventTypeForStatus = (status: string): string | null => {
  if (!OUTBOUND_WITHDRAWAL_REPLAY_STATUSES.has(status)) return null
  if (status === "payment_processed") return "transfer.payment_processed"
  return "transfer.failed"
}
