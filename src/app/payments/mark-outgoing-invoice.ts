import { paymentHashFromBolt11 } from "@domain/bitcoin/lightning"
import {
  InternalTransferMarkerError,
  InternalTransferOrigin,
} from "@domain/payment-splits"
import { ErrorLevel } from "@domain/shared"

import { recordInternalTransferInvoice } from "@services/mongoose/internal-transfer-invoices"
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
export const markOutgoingBolt11 = async ({
  paymentRequest,
  senderWalletId,
}: {
  paymentRequest: string
  senderWalletId: WalletId
}): Promise<true | InternalTransferMarkerError> => {
  const paymentHash = paymentHashFromBolt11(paymentRequest)
  if (!paymentHash || !PaymentHashRegex.test(paymentHash)) return true

  const recorded = await recordInternalTransferInvoice({
    paymentHash,
    senderWalletId,
    origin: InternalTransferOrigin.LnSend,
  })
  if (recorded instanceof Error) return new InternalTransferMarkerError(recorded)
  return true
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
