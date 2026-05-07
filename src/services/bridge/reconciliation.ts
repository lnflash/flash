import { baseLogger } from "@services/logger"
import { findIbexCryptoReceiveLogsSince } from "@services/mongoose/ibex-crypto-receive-log"
import { upsertBridgeReconciliationOrphan } from "@services/mongoose/bridge-reconciliation-orphan"
import { BridgeDepositLog } from "@services/mongoose/schema"

const ONE_DAY_MS = 24 * 60 * 60 * 1000

type BridgeDepositLike = {
  eventId: string
  transferId: string
  customerId: string
  amount: string
  currency: string
  destinationTxHash?: string
  state: string
  createdAt: Date
}

type IbexReceiveLike = {
  txHash: string
  address: string
  amount: string
  currency: string
  network: string
  accountId?: string
  receivedAt: Date
}

const toOrphanKey = (prefix: string, value: string) => `${prefix}:${value.toLowerCase()}`

export const reconcileBridgeAndIbexDeposits = async ({
  windowMs = ONE_DAY_MS,
}: {
  windowMs?: number
} = {}): Promise<
  | {
      scannedBridge: number
      scannedIbex: number
      bridgeWithoutIbex: number
      ibexWithoutBridge: number
    }
  | Error
> => {
  try {
    const now = new Date()
    const since = new Date(now.getTime() - windowMs)

    const bridgeDeposits = (await BridgeDepositLog.find({
      createdAt: { $gte: since, $lte: now },
      state: "funds_received",
    })
      .lean()
      .exec()) as BridgeDepositLike[]

    const ibexReceivesResult = await findIbexCryptoReceiveLogsSince({ since, until: now })
    if (ibexReceivesResult instanceof Error) return ibexReceivesResult
    const ibexReceives = ibexReceivesResult as IbexReceiveLike[]

    const ibexByTxHash = new Map<string, IbexReceiveLike>()
    for (const record of ibexReceives) {
      ibexByTxHash.set(record.txHash.toLowerCase(), record)
    }

    const bridgeByTxHash = new Map<string, BridgeDepositLike>()
    for (const deposit of bridgeDeposits) {
      if (!deposit.destinationTxHash) continue
      bridgeByTxHash.set(deposit.destinationTxHash.toLowerCase(), deposit)
    }

    let bridgeWithoutIbex = 0
    let ibexWithoutBridge = 0

    for (const deposit of bridgeDeposits) {
      if (!deposit.destinationTxHash) {
        bridgeWithoutIbex++
        await upsertBridgeReconciliationOrphan({
          orphanKey: toOrphanKey("bridge-no-tx", deposit.transferId),
          orphanType: "bridge_without_ibex",
          transferId: deposit.transferId,
          bridgeEventId: deposit.eventId,
          customerId: deposit.customerId,
          amount: deposit.amount,
          currency: deposit.currency,
          triageContext: {
            reason: "Bridge funds_received has no destinationTxHash",
            windowStart: since.toISOString(),
            windowEnd: now.toISOString(),
            depositState: deposit.state,
            createdAt: deposit.createdAt.toISOString(),
          },
        })
        continue
      }

      const matchedIbex = ibexByTxHash.get(deposit.destinationTxHash.toLowerCase())
      if (matchedIbex) continue

      bridgeWithoutIbex++
      await upsertBridgeReconciliationOrphan({
        orphanKey: toOrphanKey("bridge", deposit.destinationTxHash),
        orphanType: "bridge_without_ibex",
        transferId: deposit.transferId,
        txHash: deposit.destinationTxHash,
        bridgeEventId: deposit.eventId,
        customerId: deposit.customerId,
        amount: deposit.amount,
        currency: deposit.currency,
        triageContext: {
          reason:
            "No IBEX crypto.receive found for Bridge destinationTxHash within 24h window",
          windowStart: since.toISOString(),
          windowEnd: now.toISOString(),
          depositState: deposit.state,
          createdAt: deposit.createdAt.toISOString(),
        },
      })
    }

    for (const receive of ibexReceives) {
      const matchedBridge = bridgeByTxHash.get(receive.txHash.toLowerCase())
      if (matchedBridge) continue

      ibexWithoutBridge++
      await upsertBridgeReconciliationOrphan({
        orphanKey: toOrphanKey("ibex", receive.txHash),
        orphanType: "ibex_without_bridge",
        txHash: receive.txHash,
        amount: receive.amount,
        currency: receive.currency,
        triageContext: {
          reason:
            "No Bridge deposit funds_received found for IBEX tx hash within 24h window",
          windowStart: since.toISOString(),
          windowEnd: now.toISOString(),
          address: receive.address,
          network: receive.network,
          accountId: receive.accountId,
          receivedAt: receive.receivedAt.toISOString(),
        },
      })
    }

    const summary = {
      scannedBridge: bridgeDeposits.length,
      scannedIbex: ibexReceives.length,
      bridgeWithoutIbex,
      ibexWithoutBridge,
    }

    baseLogger.info(summary, "Bridge↔IBEX reconciliation completed")
    return summary
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
