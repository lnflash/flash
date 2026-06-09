import { BridgeAlert } from "./index.types"

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
}

const truncateDedupKey = (key: string): string =>
  key.length <= PAGERDUTY_DEDUP_KEY_MAX ? key : key.slice(0, PAGERDUTY_DEDUP_KEY_MAX)

/** Stable PagerDuty / inform dedup key; prefers explicit alert.dedupKey. */
export const resolveDedupKey = (alert: BridgeAlert): string => {
  if (alert.dedupKey) return truncateDedupKey(alert.dedupKey)

  const ctx = alert.context ?? {}

  switch (alert.source) {
    case "bridge-api":
      if (alert.title.includes("timeout")) return generateDedupKey.bridgeApiTimeout()
      if (alert.title.includes("request failed"))
        return generateDedupKey.bridgeApiNetwork()
      return generateDedupKey.bridgeApi5xx()
    case "erpnext-audit": {
      const transferId = String(ctx.transfer_id ?? "unknown")
      if (alert.title.includes("deposit"))
        return generateDedupKey.erpnextDepositAudit(transferId)
      if (alert.title.includes("failure")) {
        return generateDedupKey.erpnextTransferFailedAudit(transferId)
      }
      return generateDedupKey.erpnextTransferCompletedAudit(transferId)
    }
    case "bridge-webhook": {
      const eventId = String(ctx.event_id ?? ctx.transfer_id ?? "unknown")
      const transferId = String(ctx.transfer_id ?? "unknown")
      const event = String(ctx.event ?? "unknown")
      if (alert.title.includes("deposit")) {
        return generateDedupKey.bridgeWebhookDeposit(eventId)
      }
      return generateDedupKey.bridgeWebhookTransfer(transferId, event)
    }
    case "ibex": {
      const txHash = String(ctx.tx_hash ?? ctx.txHash ?? "unknown")
      const orphanType = String(ctx.orphan_type ?? "")
      if (orphanType === "ibex_without_bridge") {
        return generateDedupKey.ibexReconcileIbexWithoutBridge(txHash)
      }
      if (orphanType === "bridge_without_ibex") {
        if (txHash !== "unknown") {
          return generateDedupKey.ibexReconcileBridgeWithoutIbex(txHash)
        }
        return generateDedupKey.ibexReconcileBridgeWithoutIbexTransfer(
          String(ctx.transfer_id ?? "unknown"),
        )
      }
      if (alert.title.includes("reconciliation failed")) {
        return generateDedupKey.ibexReconcileFailed(txHash)
      }
      return generateDedupKey.ibexCryptoReceive(txHash)
    }
    default:
      return truncateDedupKey(`bridge:${alert.source}:${alert.title}`)
  }
}
