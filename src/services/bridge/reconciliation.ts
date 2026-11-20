import { sendBridgeWithdrawalNotificationBestEffort } from "@app/bridge/send-withdrawal-notification"
import { alertIbexReconciliationOrphan } from "@services/alerts/ibex-bridge-movement"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { writeBridgeCashoutCompleted } from "@services/frappe/BridgeTransferRequestWriter"
import { baseLogger } from "@services/logger"
import { findIbexCryptoReceivesSince } from "@services/mongoose/ibex-crypto-receive-log"
import {
  upsertBridgeReconciliationOrphan,
  resolveOrphansByKey,
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
import { toBridgeTransferId, type BridgeTransferId } from "@domain/primitives/bridge"

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

const WITHDRAWAL_ORPHAN_PREFIXES = [
  "withdrawal-send-failed",
  "withdrawal-ibex-sent",
  "withdrawal-ibex-sent-stuck",
] as const
type WithdrawalOrphanPrefix = (typeof WITHDRAWAL_ORPHAN_PREFIXES)[number]

// Resolves a withdrawal's open orphans once what they reported is settled, so
// the admin unmatched list shows only withdrawals that still need a person
// (ENG-891). Best effort: a failed resolve is logged and never fails the
// caller, and the next settle of the same transfer tries again.
export const resolveWithdrawalOrphans = async (
  transferId: string,
  prefixes: WithdrawalOrphanPrefix[],
): Promise<void> => {
  const keys = prefixes.map((prefix) => toOrphanKey(prefix, transferId))
  const resolved = await resolveOrphansByKey(keys)
  if (resolved instanceof Error) {
    baseLogger.warn(
      { error: resolved, transferId, keys },
      "Could not resolve Bridge withdrawal reconciliation orphans",
    )
  }
}

// A receive's Bridge deposit can predate the check's window: the hourly
// matcher records a deposit up to a week old and stamps the receive with the
// time it ran. Look the deposit up by hash before calling the receive an orphan.
export const findBridgeDepositByTxHash = (txHash: string) =>
  BridgeDeposits.findOne({
    destinationTxHash: { $eq: txHash.toLowerCase() },
    state: "payment_processed",
  })
    .collation({ locale: "en", strength: 2 })
    .lean()
    .exec()

// Alert once per orphan; the deposit check runs hourly. A failed upsert still
// alerts, since nothing else records the orphan.
const isNewOrphan = (orphan: { created: boolean } | Error): boolean =>
  orphan instanceof Error || orphan.created

export const reconcileBridgeAndIbexDeposits = async ({
  windowMs = FIFTEEN_MIN_MS,
  minAgeMs = 0,
}: {
  windowMs?: number
  // A Bridge deposit younger than this is not yet an orphan: the hourly
  // matcher (ENG-891) may still find its IBEX credit.
  minAgeMs?: number
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
      if (now.getTime() - new Date(deposit.createdAt).getTime() < minAgeMs) continue
      if (!deposit.destinationTxHash) {
        bridgeWithoutIbex++
        const reason = "Bridge payment_processed has no destinationTxHash"
        const orphan = await upsertBridgeReconciliationOrphan({
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
        if (isNewOrphan(orphan)) {
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
        }
        continue
      }

      const matchedIbex = ibexByTxHash.get(deposit.destinationTxHash.toLowerCase())
      if (matchedIbex) continue

      bridgeWithoutIbex++
      const reason =
        "No IBEX crypto.receive found for Bridge destinationTxHash within window"
      const orphan = await upsertBridgeReconciliationOrphan({
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
      if (isNewOrphan(orphan)) {
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
    }

    for (const receive of ibexReceives) {
      const matchedBridge =
        bridgeByTxHash.get(receive.txHash.toLowerCase()) ??
        (await findBridgeDepositByTxHash(receive.txHash))
      if (matchedBridge) continue

      ibexWithoutBridge++
      const reason =
        "No Bridge deposit payment_processed found for IBEX tx hash within window"
      const orphan = await upsertBridgeReconciliationOrphan({
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
      if (isNewOrphan(orphan)) {
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

/**
 * Safety net for Bridge withdrawals in flight (status usdt_sent or
 * send_failed). The Bridge transfer webhook moves usdt_sent to completed or
 * failed; this catches what it missed. Runs hourly from
 * bridge-funds-requests-cron.ts over a window long enough to keep every
 * in-flight withdrawal in view (ENG-891: it used to run daily over 15 minutes
 * and saw nothing).
 *
 *  - send_failed: IBEX never sent the USDT, so the Bridge transfer is deleted,
 *    once. A transfer Bridge already reports gone counts as deleted. Either
 *    way bridgeTransferCancelledAt stops later runs from trying again.
 *  - usdt_sent and Bridge says payment_processed (its webhook was missed):
 *    write the ERPNext Completed row, then mark the withdrawal completed,
 *    resolve its stuck orphan and tell the user and ops, as the webhook would.
 *    The row goes first: when either write fails the withdrawal stays
 *    usdt_sent and the next run tries again.
 *  - usdt_sent and Bridge failed terminally: orphan + alert (it replaces the
 *    stuck orphan, which is resolved).
 *  - usdt_sent, Bridge still working, sent more than stuckAfterMs ago:
 *    orphan + alert, since the user's USDT left IBEX and was not paid out.
 *
 * Every orphan alerts once. One withdrawal's failure (a Bridge call that
 * throws) is counted and does not stop the others.
 */
export const reconcileBridgeAndIbexWithdrawals = async ({
  windowMs = FIFTEEN_MIN_MS,
  stuckAfterMs,
}: {
  windowMs?: number
  // Unset: a withdrawal Bridge is still working on is never flagged.
  stuckAfterMs?: number
} = {}): Promise<
  | {
      scannedWithdrawals: number
      cancelledSendFailedTransfers: number
      finalizedCompletedTransfers: number
      ibexSendWithoutBridgeSettlement: number
      bridgeTransferWithoutIbexSend: number
      stuckAwaitingBridge: number
      failures: number
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
      bridgeTransferCancelledAt: { $exists: false },
    })
      .lean()
      .exec()) as BridgeWithdrawalLike[]

    let cancelledSendFailedTransfers = 0
    let finalizedCompletedTransfers = 0
    let ibexSendWithoutBridgeSettlement = 0
    let bridgeTransferWithoutIbexSend = 0
    let stuckAwaitingBridge = 0
    let failures = 0

    for (const withdrawal of withdrawals) {
      const transferId = withdrawal.bridgeTransferId
      if (!transferId) continue
      const bridgeTransferId = toBridgeTransferId(transferId)

      try {
        if (withdrawal.status === "send_failed") {
          const cancelled = await cancelSendFailedTransfer(bridgeTransferId)
          if (cancelled === true) {
            cancelledSendFailedTransfers++
            // An earlier run's delete may have failed and filed an orphan.
            await resolveWithdrawalOrphans(transferId, ["withdrawal-send-failed"])
            continue
          }

          bridgeTransferWithoutIbexSend++
          const reason = "Bridge transfer exists but IBEX crypto send failed"
          const orphan = await upsertBridgeReconciliationOrphan({
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
              deleteTransferError: cancelled.message,
            },
          })
          if (isNewOrphan(orphan)) {
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
          const audit = await writeBridgeCashoutCompleted({
            transferId,
            amount: withdrawal.amount,
            currency: withdrawal.currency,
            accountId: withdrawal.accountId,
            sourceEventType: "bridge.withdrawal.reconciled",
            rawPayload: transfer,
          })
          if (audit instanceof Error) {
            failures++
            baseLogger.error(
              { error: audit, transferId },
              "Could not write the ERPNext Completed row of a withdrawal Bridge paid out; the next run retries",
            )
            continue
          }

          const finalized = await BridgeAccountsRepo.updateWithdrawalStatus(
            bridgeTransferId,
            "completed",
          )
          if (finalized instanceof Error) {
            failures++
            baseLogger.error(
              { error: finalized, transferId },
              "Could not mark a withdrawal Bridge paid out as completed; the next run retries",
            )
            continue
          }

          finalizedCompletedTransfers++
          await resolveWithdrawalOrphans(transferId, ["withdrawal-ibex-sent-stuck"])
          notifyOpsEvent({
            flow: "transfer",
            phase: "succeeded",
            status: "success",
            accountId: withdrawal.accountId,
            amount: { value: withdrawal.amount, currency: withdrawal.currency },
            meta: { transferId, source: "withdrawal-check" },
          })
          await sendBridgeWithdrawalNotificationBestEffort({
            accountId: withdrawal.accountId,
            amount: withdrawal.amount,
            currency: withdrawal.currency,
            outcome: "completed",
          })
          continue
        }

        const terminal = WITHDRAWAL_TERMINAL_FAILURE_STATES.has(transfer.state)
        const sentAt = new Date(withdrawal.updatedAt).getTime()
        const stuck =
          !terminal && stuckAfterMs !== undefined && now.getTime() - sentAt > stuckAfterMs
        if (!terminal && !stuck) continue

        if (terminal) ibexSendWithoutBridgeSettlement++
        else stuckAwaitingBridge++
        const reason = terminal
          ? `IBEX crypto send succeeded but Bridge transfer is ${transfer.state}`
          : `IBEX crypto send succeeded but Bridge transfer is still ${transfer.state} after ${Math.round(
              (now.getTime() - sentAt) / 3_600_000,
            )}h`
        const orphan = await upsertBridgeReconciliationOrphan({
          orphanKey: toOrphanKey(
            terminal ? "withdrawal-ibex-sent" : "withdrawal-ibex-sent-stuck",
            transferId,
          ),
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
        if (terminal) {
          await resolveWithdrawalOrphans(transferId, ["withdrawal-ibex-sent-stuck"])
        }
        if (isNewOrphan(orphan)) {
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
      } catch (error) {
        failures++
        baseLogger.error(
          { error, transferId, status: withdrawal.status },
          "Bridge withdrawal reconciliation failed for one withdrawal",
        )
      }
    }

    const summary = {
      scannedWithdrawals: withdrawals.length,
      cancelledSendFailedTransfers,
      finalizedCompletedTransfers,
      ibexSendWithoutBridgeSettlement,
      bridgeTransferWithoutIbexSend,
      stuckAwaitingBridge,
      failures,
    }

    baseLogger.info(summary, "Bridge withdrawal reconciliation completed")
    return summary
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

// Deletes the Bridge transfer of a withdrawal whose IBEX send failed, and
// records that it is gone. A failed delete of a transfer Bridge already shows
// as canceled (or otherwise finished without paying out) also counts as gone,
// so a repeat run never alerts on a transfer it deleted earlier.
const cancelSendFailedTransfer = async (
  bridgeTransferId: BridgeTransferId,
): Promise<true | Error> => {
  let deleteError: Error | undefined
  try {
    await BridgeApiClient.deleteTransfer(bridgeTransferId)
  } catch (error) {
    deleteError = error instanceof Error ? error : new Error(String(error))
    const transfer = await BridgeApiClient.getTransfer(bridgeTransferId).catch(
      () => undefined,
    )
    if (!transfer || !WITHDRAWAL_TERMINAL_FAILURE_STATES.has(transfer.state)) {
      return deleteError
    }
  }

  const marked =
    await BridgeAccountsRepo.markSendFailedTransferCancelled(bridgeTransferId)
  if (marked instanceof Error) {
    // The transfer is gone; the next run deletes again and lands here.
    baseLogger.warn(
      { error: marked, bridgeTransferId, deleteError },
      "Could not record a cancelled Bridge withdrawal transfer",
    )
  }
  return true
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
