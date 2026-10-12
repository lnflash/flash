import { PaymentSendStatus, paymentHashFromBolt11 } from "@domain/bitcoin/lightning"
import {
  InternalTransferMarkerError,
  InternalTransferOrigin,
} from "@domain/payment-splits"
import { ErrorLevel } from "@domain/shared"

import {
  CompletedInvoice,
  FailedIbexPayment,
  IbexError,
  InsufficientIbexBalance,
} from "@services/ibex/errors"
import {
  deleteInternalTransferInvoice,
  insertInternalTransferInvoice,
  recordInternalTransferInvoice,
} from "@services/mongoose/internal-transfer-invoices"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"

const PaymentHashRegex = /^[0-9a-f]{64}$/i

/**
 * ENG-653 decision 1: a Flash-to-Flash payment never triggers the recipient's
 * payment splits. A Flash user who scans another Flash user's bolt11 pays an
 * invoice IBEX settles internally, and the recipient's on-receive webhook
 * fires just like for an external payer. Flash cannot cheaply tell whether a
 * bolt11 belongs to one of its own wallets, so it marks every bolt11 its users
 * pay: an external invoice never comes back through Flash's receive webhook,
 * so marking it is harmless.
 *
 * Fails closed, like the intraledger marker: when the hash is readable but the
 * marker cannot be written, nothing is paid. A bolt11 the decoder cannot parse
 * is paid unmarked: every invoice IBEX mints for a Flash wallet decodes (the
 * intraledger marker depends on that), so an undecodable one is external.
 */
type OutgoingBolt11Marker = { paymentHash: string; created: boolean } | null

const markOutgoing = async ({
  paymentRequest,
  senderWalletId,
}: {
  paymentRequest: string
  senderWalletId: WalletId
}): Promise<OutgoingBolt11Marker | InternalTransferMarkerError> => {
  const paymentHash = paymentHashFromBolt11(paymentRequest)
  if (!paymentHash || !PaymentHashRegex.test(paymentHash)) return null

  const inserted = await insertInternalTransferInvoice({
    paymentHash,
    senderWalletId,
    origin: InternalTransferOrigin.LnSend,
  })
  if (inserted instanceof Error) return new InternalTransferMarkerError(inserted)
  return { paymentHash, created: inserted.created }
}

export const markOutgoingBolt11 = async (args: {
  paymentRequest: string
  senderWalletId: WalletId
}): Promise<true | InternalTransferMarkerError> => {
  const marked = await markOutgoing(args)
  return marked instanceof Error ? marked : true
}

/**
 * True only when IBEX refused the payment before any money moved: an
 * insufficient balance, a corroborated FAILED status, an already-paid (or
 * already-prepared) invoice, or any other 4xx the request was rejected with
 * (no route, expired invoice, rate limit). Never true for a pending or
 * unreadable outcome, a transport error or a 5xx (the payment may still
 * settle).
 *
 * An already-paid invoice is a rejection of THIS caller: it paid nothing.
 * Markers are one row per (hash, sender, origin), so a Flash wallet that did
 * pay the invoice has its own row, and withdrawing this caller's row protects
 * nobody. Keeping it would let any Flash user suppress a merchant's splits by
 * attempting to pay a bolt11 an external customer already paid.
 */
export const isDefinitivePaymentRejection = (result: unknown): boolean => {
  if (result === PaymentSendStatus.Failure) return true
  if (result instanceof InsufficientIbexBalance) return true
  if (result instanceof FailedIbexPayment) return true
  if (result instanceof CompletedInvoice) return true
  if (result instanceof IbexError) {
    const code = result.httpCode
    return code !== undefined && code >= 400 && code < 500 && code !== 408
  }
  return false
}

/**
 * Marks the bolt11 (markOutgoingBolt11), runs `pay`, and withdraws the marker
 * again when IBEX rejected the payment outright. Without that, a Flash user's
 * failed attempt on a merchant's QR would leave a 30-day marker behind and the
 * merchant's splits would not fire when a wallet outside Flash paid the same
 * invoice afterwards.
 *
 * The marker is withdrawn only when this call created it, and only this
 * sender's row is removed: markers are one row per (hash, sender, origin), so
 * a concurrent payment of the same bolt11 by another Flash wallet keeps its
 * own row and the hash stays internal.
 */
export const payMarkedBolt11 = async <T>({
  paymentRequest,
  senderWalletId,
  pay,
}: {
  paymentRequest: string
  senderWalletId: WalletId
  pay: () => Promise<T>
}): Promise<T | InternalTransferMarkerError> => {
  const marker = await markOutgoing({ paymentRequest, senderWalletId })
  if (marker instanceof Error) return marker

  const result = await pay()

  if (marker?.created && isDefinitivePaymentRejection(result)) {
    const removed = await deleteInternalTransferInvoice({
      paymentHash: marker.paymentHash,
      senderWalletId,
      origin: InternalTransferOrigin.LnSend,
    })
    if (removed instanceof Error) {
      baseLogger.error(
        { err: removed, paymentHash: marker.paymentHash, senderWalletId },
        "Payment splits: could not withdraw the marker of a rejected ln-send",
      )
      recordExceptionInCurrentSpan({
        error: removed,
        level: ErrorLevel.Critical,
        fallbackMsg:
          "Payment splits: a rejected ln-send left its marker; the payee's splits will not fire if another wallet pays this invoice",
        attributes: { "paymentSplits.paymentHash": marker.paymentHash },
      })
    }
  }

  return result
}

/**
 * LNURL counterpart of markOutgoingBolt11. IBEX fetches the LNURL invoice and
 * pays it in one call, so the hash is only known after the payment. The
 * marker is written then; the split executor re-checks it before paying, so a
 * receive recorded in the gap is skipped (`skipped_internal`), not paid.
 * Best effort: the money already moved, so a failure is logged, not returned.
 */
export const markPaidLnurlHash = async ({
  paymentHash,
  senderWalletId,
}: {
  paymentHash: unknown
  senderWalletId: WalletId
}): Promise<void> => {
  if (typeof paymentHash !== "string" || !PaymentHashRegex.test(paymentHash)) return

  const recorded = await recordInternalTransferInvoice({
    paymentHash,
    senderWalletId,
    origin: InternalTransferOrigin.LnurlSend,
  })
  if (recorded instanceof Error) {
    baseLogger.error(
      { err: recorded, paymentHash, senderWalletId },
      "Payment splits: could not mark a paid LNURL hash",
    )
    recordExceptionInCurrentSpan({
      error: recorded,
      level: ErrorLevel.Critical,
      fallbackMsg:
        "Payment splits: could not mark a paid LNURL hash; a Flash payee's splits may fire",
      attributes: { "paymentSplits.paymentHash": paymentHash },
    })
  }
}
