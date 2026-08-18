export const PAGERDUTY_DEDUP_KEY_MAX = 255

const OUTAGE_TTL_MS = 30 * 60 * 1000
const DEFAULT_TTL_MS = 60 * 60 * 1000

/** TTL for Slack/Discord first-alert suppression per dedup key class. */
export const informDedupTtlMs = (dedupKey: string): number =>
  dedupKey.startsWith("bridge-api") ? OUTAGE_TTL_MS : DEFAULT_TTL_MS

export const generateDedupKey = {
  bridgeApi5xx: () => "bridge-api:5xx",
  bridgeApiTimeout: () => "bridge-api:timeout",
  bridgeApiNetwork: () => "bridge-api:network",
  erpnextDepositAudit: (transferId: string) => `erpnext-audit:deposit:${transferId}`,
  erpnextTransferCompletedAudit: (transferId: string) =>
    `erpnext-audit:transfer-complete:${transferId}`,
  erpnextTransferFailedAudit: (transferId: string) =>
    `erpnext-audit:transfer-failed:${transferId}`,
  bridgeWebhookDeposit: (eventId: string) => `bridge-webhook:deposit:${eventId}`,
  bridgeWebhookTransfer: (transferId: string, event: string) =>
    `bridge-webhook:transfer:${transferId}:${event}`,
  ibexCryptoReceive: (txHash: string) => `ibex:crypto-receive:${txHash.toLowerCase()}`,
  ibexReconcileBridgeWithoutIbex: (txHash: string) =>
    `ibex:reconcile:bridge-without-ibex:${txHash.toLowerCase()}`,
  ibexReconcileBridgeWithoutIbexTransfer: (transferId: string) =>
    `ibex:reconcile:bridge-without-ibex:transfer:${transferId}`,
  ibexReconcileIbexWithoutBridge: (txHash: string) =>
    `ibex:reconcile:ibex-without-bridge:${txHash.toLowerCase()}`,
  ibexReconcileFailed: (txHash: string) =>
    `ibex:reconcile:failed:${txHash.toLowerCase()}`,
  erpnextFygaroAudit: (transactionId: string) => `erpnext-audit:fygaro:${transactionId}`,
  fygaroWebhookPayment: (transactionId: string) =>
    `fygaro-webhook:payment:${transactionId}`,
  fygaroUnattributed: (transactionId: string) => `fygaro:unattributed:${transactionId}`,
  fygaroCreditFailed: (transactionId: string) => `fygaro:credit-failed:${transactionId}`,
  // A gate blocked auto-credit (over-limit, settings unavailable, disabled,
  // non-USD, non-positive net). Distinct from fygaroCreditFailed so a "skipped"
  // warning never suppresses a later "credit attempt failed" critical.
  fygaroNotCredited: (transactionId: string) => `fygaro:not-credited:${transactionId}`,
  // The refusal was decided but could NOT be stamped onto the ERPNext row, so
  // the payment keeps counting against the customer's daily allowance. Its own
  // key, never `erpnextFygaroAudit`: that one is already claimed by the
  // audit-WRITE failure on the very delivery that most often precedes this one
  // (write fails -> critical -> 500 -> Fygaro retries -> write succeeds, gate
  // refuses, stamp fails). Sharing a key means Slack/Discord suppress the
  // second alert for the whole informDedupTtlMs window and PagerDuty folds it
  // into the open incident — the same anti-pattern fygaroNotCredited vs
  // fygaroCreditFailed exists to avoid.
  fygaroRefusalNotStamped: (transactionId: string) =>
    `fygaro:refusal-not-stamped:${transactionId}`,
  // Static keys (no per-request suffix) so the built-in TTL dedup rate-limits
  // these to one alert per window rather than one per failing request/poll.
  fygaroSignatureFailure: () => "fygaro:signature-failure",
  // Distinct from fygaroSignatureFailure so a stuck server clock (every real
  // webhook 401ing on skew) surfaces as its own warning instead of being
  // collapsed into — or masked by — the "wrong secret" alert. Still static so
  // replayed old webhooks collapse to one warning per window.
  fygaroClockSkew: () => "fygaro:clock-skew",
  fygaroFloatLow: () => "fygaro:float-low",
  fygaroFloatExhausted: () => "fygaro:float-exhausted",
  // The account repository faulted while resolving a customReference. Static
  // (no transaction suffix) because this is an infrastructure outage, not a
  // per-payment anomaly: every in-flight delivery hits it at once and should
  // collapse into one alert per window. Distinct from fygaroUnattributed so an
  // outage never masquerades as "this payer typed a bad username".
  fygaroAccountLookupFailed: () => "fygaro:account-lookup-failed",
  // The PRE-charge allowance check could not run: ERPNext settings, ERPNext
  // 24h history, or the Redis reservation index. Static per reason — an outage
  // refuses every card top-up at once, so it must collapse into ONE incident
  // per failing dependency rather than one per refused customer. The reason is
  // in the key (not just the body) so a Redis outage never lands in the same
  // incident as an ERPNext one and get triaged as the wrong system.
  fygaroAuthorizeUnavailable: (reason: string) =>
    `fygaro:authorize-unavailable:${reason}`,
}

export const normalizeDedupKey = (key: string): string =>
  key.length <= PAGERDUTY_DEDUP_KEY_MAX ? key : key.slice(0, PAGERDUTY_DEDUP_KEY_MAX)
