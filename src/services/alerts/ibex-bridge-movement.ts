import { alertBridge } from "./index"
import { generateDedupKey } from "./dedup-key"

type IbexMovementAlert = {
  title: string
  detail?: string
  context?: Record<string, unknown>
}

const alertIbexMovement = (dedupKey: string, alert: IbexMovementAlert): void => {
  alertBridge({
    dedupKey,
    source: "ibex",
    severity: "warning",
    ...alert,
  })
}

export const alertIbexCryptoReceiveFailure = ({
  txHash,
  code,
  title,
  detail,
  context,
}: {
  txHash: string
  code: string
  title: string
  detail?: string
  context?: Record<string, unknown>
}): void => {
  alertIbexMovement(generateDedupKey.ibexCryptoReceive(txHash), {
    title,
    detail,
    context: { tx_hash: txHash, code, ...context },
  })
}

export const alertIbexReconciliationOrphan = ({
  orphanType,
  txHash,
  transferId,
  reason,
  context,
}: {
  orphanType: "bridge_without_ibex" | "ibex_without_bridge"
  txHash?: string
  transferId?: string
  reason: string
  context?: Record<string, unknown>
}): void => {
  const dedupKey =
    orphanType === "ibex_without_bridge" && txHash
      ? generateDedupKey.ibexReconcileIbexWithoutBridge(txHash)
      : txHash
        ? generateDedupKey.ibexReconcileBridgeWithoutIbex(txHash)
        : generateDedupKey.ibexReconcileBridgeWithoutIbexTransfer(transferId ?? "unknown")

  const title =
    orphanType === "ibex_without_bridge"
      ? "IBEX crypto receive without matching Bridge deposit"
      : "Bridge deposit without matching IBEX crypto receive"

  alertIbexMovement(dedupKey, {
    title,
    detail: reason,
    context: {
      orphan_type: orphanType,
      tx_hash: txHash,
      transfer_id: transferId,
      ...context,
    },
  })
}

export const alertIbexReconciliationFailed = ({
  txHash,
  detail,
}: {
  txHash: string
  detail: string
}): void => {
  alertIbexMovement(generateDedupKey.ibexReconcileFailed(txHash), {
    title: "Bridge↔IBEX reconciliation failed",
    detail,
    context: { tx_hash: txHash },
  })
}
