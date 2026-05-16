import { baseLogger } from "@services/logger"
import { findIbexCryptoReceiveLogsSince } from "@services/mongoose/ibex-crypto-receive-log"
import {
  upsertBridgeReconciliationOrphan,
  resolveOrphansByTxHash,
} from "@services/mongoose/bridge-reconciliation-orphan"
import { BridgeDepositLog, IbexCryptoReceiveLog } from "@services/mongoose/schema"
import { PubSubService } from "@services/pubsub"
import { PubSubDefaultTriggers } from "@domain/pubsub"

const FIFTEEN_MIN_MS = 15 * 60 * 1000

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
  windowMs = FIFTEEN_MIN_MS,
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
      state: "payment_processed",
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
            reason: "Bridge payment_processed has no destinationTxHash",
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
            "No IBEX crypto.receive found for Bridge destinationTxHash within window",
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
            "No Bridge deposit payment_processed found for IBEX tx hash within window",
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

type ReconcileByTxHashResult = {
  txHash: string
  status: "matched" | "unmatched"
  orphanType?: "bridge_without_ibex" | "ibex_without_bridge"
  transferId?: string
  customerId?: string
  amount?: string
  currency?: string
  detectedAt: Date
}

export const reconcileByTxHash = async ({
  txHash,
}: {
  txHash: string
}): Promise<ReconcileByTxHashResult | Error> => {
  const normalizedHash = txHash.toLowerCase()
  const now = new Date()

  try {
    const [bridgeDeposit, ibexReceive] = await Promise.all([
      BridgeDepositLog.findOne({
        destinationTxHash: { $regex: new RegExp(`^${normalizedHash}$`, "i") },
        state: "payment_processed",
      })
        .lean()
        .exec(),
      IbexCryptoReceiveLog.findOne({
        txHash: { $regex: new RegExp(`^${normalizedHash}$`, "i") },
      })
        .lean()
        .exec(),
    ])

    const pubsub = PubSubService()

    if (bridgeDeposit && ibexReceive) {
      await resolveOrphansByTxHash(normalizedHash)

      const event: ReconcileByTxHashResult = {
        txHash: normalizedHash,
        status: "matched",
        transferId: (bridgeDeposit as BridgeDepositLike).transferId,
        customerId: (bridgeDeposit as BridgeDepositLike).customerId,
        amount: (bridgeDeposit as BridgeDepositLike).amount,
        currency: (bridgeDeposit as BridgeDepositLike).currency,
        detectedAt: now,
      }

      baseLogger.info(event, "Bridge↔IBEX real-time reconciliation: matched")
      pubsub.publish({
        trigger: PubSubDefaultTriggers.BridgeReconciliationUpdate,
        payload: event,
      })
      return event
    }

    let orphanType: "bridge_without_ibex" | "ibex_without_bridge"
    let orphanKey: string
    let triageContext: Record<string, unknown>
    let transferId: string | undefined
    let customerId: string | undefined
    let amount: string | undefined
    let currency: string | undefined

    if (bridgeDeposit && !ibexReceive) {
      orphanType = "bridge_without_ibex"
      orphanKey = toOrphanKey("bridge", normalizedHash)
      transferId = (bridgeDeposit as BridgeDepositLike).transferId
      customerId = (bridgeDeposit as BridgeDepositLike).customerId
      amount = (bridgeDeposit as BridgeDepositLike).amount
      currency = (bridgeDeposit as BridgeDepositLike).currency
      triageContext = {
        reason: "Bridge payment_processed has no matching IBEX crypto.receive yet",
        txHash: normalizedHash,
        depositState: (bridgeDeposit as BridgeDepositLike).state,
        createdAt: (bridgeDeposit as BridgeDepositLike).createdAt.toISOString(),
        detectedAt: now.toISOString(),
      }
    } else {
      orphanType = "ibex_without_bridge"
      orphanKey = toOrphanKey("ibex", normalizedHash)
      amount = ibexReceive ? (ibexReceive as IbexReceiveLike).amount : undefined
      currency = ibexReceive ? (ibexReceive as IbexReceiveLike).currency : undefined
      triageContext = {
        reason: "IBEX crypto.receive has no matching Bridge funds_received yet",
        txHash: normalizedHash,
        address: ibexReceive ? (ibexReceive as IbexReceiveLike).address : undefined,
        network: ibexReceive ? (ibexReceive as IbexReceiveLike).network : undefined,
        detectedAt: now.toISOString(),
      }
    }

    await upsertBridgeReconciliationOrphan({
      orphanKey,
      orphanType,
      txHash: normalizedHash,
      transferId,
      customerId,
      amount,
      currency,
      triageContext,
    })

    const event: ReconcileByTxHashResult = {
      txHash: normalizedHash,
      status: "unmatched",
      orphanType,
      transferId,
      customerId,
      amount,
      currency,
      detectedAt: now,
    }

    baseLogger.info(event, "Bridge↔IBEX real-time reconciliation: unmatched")
    pubsub.publish({
      trigger: PubSubDefaultTriggers.BridgeReconciliationUpdate,
      payload: event,
    })
    return event
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
