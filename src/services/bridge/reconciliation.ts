import { alertIbexReconciliationOrphan } from "@services/alerts/ibex-bridge-movement"
import { baseLogger } from "@services/logger"
import { findIbexCryptoReceivesSince } from "@services/mongoose/ibex-crypto-receive-log"
import {
  upsertBridgeReconciliationOrphan,
  resolveOrphansByTxHash,
} from "@services/mongoose/bridge-reconciliation-orphan"
import {
  BridgeDeposits,
  BridgeWithdrawal,
  IbexCryptoReceive,
} from "@services/mongoose/schema"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import { PubSubService } from "@services/pubsub"
import { PubSubDefaultTriggers } from "@domain/pubsub"
import { toBridgeTransferId } from "@domain/primitives/bridge"

import BridgeApiClient from "./client"

const FIFTEEN_MIN_MS = 15 * 60 * 1000

const WITHDRAWAL_TERMINAL_FAILURE_STATES = new Set([
  "undeliverable",
  "returned",
  "refunded",
  "refund_failed",
  "missing_return_policy",
  "error",
  "canceled",
])

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

type BridgeWithdrawalLike = {
  id?: string
  _id?: { toString(): string } | string
  accountId: string
  bridgeTransferId?: string
  bridgeDepositAddress?: string
  ibexPayoutId?: string
  amount: string
  currency: string
  status: "usdt_sent" | "send_failed"
  failureReason?: string
  updatedAt: Date
  createdAt: Date
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

    const bridgeDeposits = (await BridgeDeposits.find({
      createdAt: { $gte: since, $lte: now },
      state: "payment_processed",
    })
      .lean()
      .exec()) as BridgeDepositLike[]

    const ibexReceivesResult = await findIbexCryptoReceivesSince({ since, until: now })
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
        const reason = "Bridge payment_processed has no destinationTxHash"
        await upsertBridgeReconciliationOrphan({
          orphanKey: toOrphanKey("bridge-no-tx", deposit.transferId),
          orphanType: "bridge_without_ibex",
          transferId: deposit.transferId,
          bridgeEventId: deposit.eventId,
          customerId: deposit.customerId,
          amount: deposit.amount,
          currency: deposit.currency,
          triageContext: {
            reason,
            windowStart: since.toISOString(),
            windowEnd: now.toISOString(),
            depositState: deposit.state,
            createdAt: deposit.createdAt.toISOString(),
          },
        })
        alertIbexReconciliationOrphan({
          orphanType: "bridge_without_ibex",
          transferId: deposit.transferId,
          reason,
          context: {
            bridge_event_id: deposit.eventId,
            customer_id: deposit.customerId,
            amount: deposit.amount,
            currency: deposit.currency,
          },
        })
        continue
      }

      const matchedIbex = ibexByTxHash.get(deposit.destinationTxHash.toLowerCase())
      if (matchedIbex) continue

      bridgeWithoutIbex++
      const reason =
        "No IBEX crypto.receive found for Bridge destinationTxHash within window"
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
          reason,
          windowStart: since.toISOString(),
          windowEnd: now.toISOString(),
          depositState: deposit.state,
          createdAt: deposit.createdAt.toISOString(),
        },
      })
      alertIbexReconciliationOrphan({
        orphanType: "bridge_without_ibex",
        txHash: deposit.destinationTxHash,
        transferId: deposit.transferId,
        reason,
        context: {
          bridge_event_id: deposit.eventId,
          customer_id: deposit.customerId,
          amount: deposit.amount,
          currency: deposit.currency,
        },
      })
    }

    for (const receive of ibexReceives) {
      const matchedBridge = bridgeByTxHash.get(receive.txHash.toLowerCase())
      if (matchedBridge) continue

      ibexWithoutBridge++
      const reason =
        "No Bridge deposit payment_processed found for IBEX tx hash within window"
      await upsertBridgeReconciliationOrphan({
        orphanKey: toOrphanKey("ibex", receive.txHash),
        orphanType: "ibex_without_bridge",
        txHash: receive.txHash,
        amount: receive.amount,
        currency: receive.currency,
        triageContext: {
          reason,
          windowStart: since.toISOString(),
          windowEnd: now.toISOString(),
          address: receive.address,
          network: receive.network,
          accountId: receive.accountId,
          receivedAt: receive.receivedAt.toISOString(),
        },
      })
      alertIbexReconciliationOrphan({
        orphanType: "ibex_without_bridge",
        txHash: receive.txHash,
        reason,
        context: {
          amount: receive.amount,
          currency: receive.currency,
          address: receive.address,
          network: receive.network,
          account_id: receive.accountId,
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

export const reconcileBridgeAndIbexWithdrawals = async ({
  windowMs = FIFTEEN_MIN_MS,
}: {
  windowMs?: number
} = {}): Promise<
  | {
      scannedWithdrawals: number
      cancelledSendFailedTransfers: number
      finalizedCompletedTransfers: number
      ibexSendWithoutBridgeSettlement: number
      bridgeTransferWithoutIbexSend: number
    }
  | Error
> => {
  try {
    const now = new Date()
    const since = new Date(now.getTime() - windowMs)

    const withdrawals = (await BridgeWithdrawal.find({
      updatedAt: { $gte: since, $lte: now },
      status: { $in: ["usdt_sent", "send_failed"] },
      bridgeTransferId: { $exists: true },
    })
      .lean()
      .exec()) as BridgeWithdrawalLike[]

    let cancelledSendFailedTransfers = 0
    let finalizedCompletedTransfers = 0
    let ibexSendWithoutBridgeSettlement = 0
    let bridgeTransferWithoutIbexSend = 0

    for (const withdrawal of withdrawals) {
      const transferId = withdrawal.bridgeTransferId
      if (!transferId) continue
      const bridgeTransferId = toBridgeTransferId(transferId)

      if (withdrawal.status === "send_failed") {
        try {
          await BridgeApiClient.deleteTransfer(bridgeTransferId)
          cancelledSendFailedTransfers++
        } catch (error) {
          bridgeTransferWithoutIbexSend++
          const reason = "Bridge transfer exists but IBEX crypto send failed"
          await upsertBridgeReconciliationOrphan({
            orphanKey: toOrphanKey("withdrawal-send-failed", transferId),
            orphanType: "bridge_transfer_without_ibex_send",
            transferId,
            amount: withdrawal.amount,
            currency: withdrawal.currency,
            triageContext: {
              reason,
              windowStart: since.toISOString(),
              windowEnd: now.toISOString(),
              accountId: withdrawal.accountId,
              bridgeDepositAddress: withdrawal.bridgeDepositAddress,
              failureReason: withdrawal.failureReason,
              deleteTransferError: error instanceof Error ? error.message : String(error),
            },
          })
          alertIbexReconciliationOrphan({
            orphanType: "bridge_transfer_without_ibex_send",
            transferId,
            reason,
            context: {
              account_id: withdrawal.accountId,
              amount: withdrawal.amount,
              currency: withdrawal.currency,
            },
          })
        }
        continue
      }

      const transfer = await BridgeApiClient.getTransfer(bridgeTransferId)
      if (transfer.state === "payment_processed") {
        const finalized = await BridgeAccountsRepo.updateWithdrawalStatus(
          bridgeTransferId,
          "completed",
        )
        if (!(finalized instanceof Error)) finalizedCompletedTransfers++
        continue
      }

      if (!WITHDRAWAL_TERMINAL_FAILURE_STATES.has(transfer.state)) continue

      ibexSendWithoutBridgeSettlement++
      const reason = `IBEX crypto send succeeded but Bridge transfer is ${transfer.state}`
      await upsertBridgeReconciliationOrphan({
        orphanKey: toOrphanKey("withdrawal-ibex-sent", transferId),
        orphanType: "ibex_send_without_bridge_settlement",
        transferId,
        customerId: transfer.on_behalf_of,
        amount: withdrawal.amount,
        currency: withdrawal.currency,
        triageContext: {
          reason,
          windowStart: since.toISOString(),
          windowEnd: now.toISOString(),
          accountId: withdrawal.accountId,
          ibexPayoutId: withdrawal.ibexPayoutId,
          bridgeState: transfer.state,
        },
      })
      alertIbexReconciliationOrphan({
        orphanType: "ibex_send_without_bridge_settlement",
        transferId,
        reason,
        context: {
          account_id: withdrawal.accountId,
          ibex_payout_id: withdrawal.ibexPayoutId,
          bridge_state: transfer.state,
          amount: withdrawal.amount,
          currency: withdrawal.currency,
        },
      })
    }

    const summary = {
      scannedWithdrawals: withdrawals.length,
      cancelledSendFailedTransfers,
      finalizedCompletedTransfers,
      ibexSendWithoutBridgeSettlement,
      bridgeTransferWithoutIbexSend,
    }

    baseLogger.info(summary, "Bridge withdrawal reconciliation completed")
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
      BridgeDeposits.findOne({
        destinationTxHash: { $eq: normalizedHash },
        state: "payment_processed",
      })
        .collation({ locale: "en", strength: 2 })
        .lean()
        .exec(),
      IbexCryptoReceive.findOne({
        txHash: { $eq: normalizedHash },
      })
        .collation({ locale: "en", strength: 2 })
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

    alertIbexReconciliationOrphan({
      orphanType,
      txHash: normalizedHash,
      transferId,
      reason: String(triageContext.reason),
      context: {
        customer_id: customerId,
        amount,
        currency,
      },
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
