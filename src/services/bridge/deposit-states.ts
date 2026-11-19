// Bridge deposit states that mean the money will not reach the customer, and
// the ops-facing reason for each (ENG-889). Shared by the deposit webhook route
// (alerting) and the ERPNext deposit writer (status and failure_reason).

const asOptionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  return String(value)
}

// The `refund` block on refund_in_flight / refunded / refund_failed
// virtual-account activity. `risk_rejection_reason` and `refund_reference_id`
// are not in Bridge's published example but were on the 2026-11-13 production
// refund.
export type BridgeDepositRefund = {
  code?: unknown
  reason?: unknown
  refunded_at?: unknown
  refund_reference_id?: unknown
  risk_rejection_reason?: unknown
}

// Deposit states after which Bridge will deliver nothing to the customer.
// `refunded` and `refund_failed` are the virtual-account terminal failure
// events (https://apidocs.bridge.xyz/platform/orchestration/virtual_accounts/virtual-account-events.md,
// "Terminal events"); the rest are the transfer-shaped terminal failure states
// in BridgeTransfer["status"], which reach the deposit writer through transfer-category
// deposit events. `refund_in_flight` is NOT here: it is transient and always
// ends in `refunded` or `refund_failed`.
export const BRIDGE_DEPOSIT_TERMINAL_FAILURE_STATES: ReadonlySet<string> = new Set([
  "refunded",
  "refund_failed",
  "returned",
  "undeliverable",
  "missing_return_policy",
  "error",
  "canceled",
])

// States that mean Bridge is sending, or tried to send, the money back. The
// deposit route alerts ops on each of them.
export const BRIDGE_DEPOSIT_REFUND_STATES: ReadonlySet<string> = new Set([
  "refund_in_flight",
  "refunded",
  "refund_failed",
])

const refundText = (refund?: BridgeDepositRefund): string | undefined => {
  if (!refund) return undefined
  const code = asOptionalString(refund.code)?.trim()
  const reason = asOptionalString(refund.reason)?.trim()
  const riskReason = asOptionalString(refund.risk_rejection_reason)?.trim()
  const reference = asOptionalString(refund.refund_reference_id)?.trim()

  const head = [code, reason].filter(Boolean).join(" ")
  const withRisk = riskReason ? `${head}${head ? " " : ""}(${riskReason})` : head
  const parts = [withRisk, reference ? `ref ${reference}` : undefined].filter(Boolean)
  return parts.length ? parts.join(", ") : undefined
}

// The ops-facing reason written to `failure_reason` for a deposit Bridge is
// refunding or failed to deliver. Undefined for every other state, so a normal
// deposit event never sends the field and never touches a stored reason.
// e.g. "Refunded by Bridge: R03 Risk Rejection (Third Party Payment), ref 123"
export const bridgeDepositFailureReason = ({
  state,
  refund,
}: {
  state: string
  refund?: BridgeDepositRefund
}): string | undefined => {
  const detail = refundText(refund)
  const withDetail = (prefix: string) => (detail ? `${prefix}: ${detail}` : prefix)

  switch (state) {
    case "refunded":
      return withDetail("Refunded by Bridge")
    case "refund_in_flight":
      return withDetail("Refund in progress at Bridge")
    case "refund_failed":
      return withDetail("Bridge refund failed, funds held at Bridge")
    default:
      return BRIDGE_DEPOSIT_TERMINAL_FAILURE_STATES.has(state)
        ? withDetail(`Bridge deposit ${state}`)
        : undefined
  }
}
