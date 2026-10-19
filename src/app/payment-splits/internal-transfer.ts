import { decodeInvoice, PaymentSendStatus } from "@domain/bitcoin/lightning"
import { InternalTransferOrigin } from "@domain/payment-splits"
import { InternalTransferMarkerError } from "@domain/payment-splits/errors"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"

import { recordInternalTransferInvoice } from "@services/mongoose/internal-transfer-invoices"

import Ibex from "@services/ibex/client"
import { UnexpectedIbexResponse } from "@services/ibex/errors"
import { paymentSendStatusOrPending } from "@services/ibex/payment-status"

const PaymentHashRegex = /^[0-9a-f]{64}$/i

export type SplitPayoutArgs = {
  // The shadow receive account the leg pays FROM.
  sourceIbexAccountId: string
  // The merchant or destination wallet the leg pays TO. A Flash wallet id IS
  // an IBEX account id.
  destinationWalletId: string
  cents: number
  currency: string
  memo: string
}

export type SplitPayoutProgress = {
  // The recipient invoice was minted and the marker written: from here IBEX
  // may debit the shadow. Errors before this are safe to retry wholesale.
  payInvoiceReached?: boolean
}

/**
 * One payout leg of a split settle: the shadow pays a Flash wallet.
 *
 * Deliberately NOT intraledgerPaymentSendWalletIdForUsdWallet (decision 1):
 * that path validates the SENDER as a Flash wallet and runs the ENG-573 send
 * guards against the merchant's account. The shadow has no Flash account, and
 * a split payout must not consume the merchant's send limits or demand its
 * KYC level — the money is the merchant's own inbound payment being handed
 * over, not a send.
 *
 * Sequence mirrors send-intraledger's: mark the recipient invoice internal
 * (origin "split") BEFORE paying, fail closed on a marker error (nothing has
 * moved), then addInvoice + payInvoice against the shadow. Internal pays are
 * fee-free and synchronous on IBEX (Phase 0), so the pay response's payment
 * status is settlement truth; it is read with the shared reader, whose
 * unconfirmed-outcome mapping this caller treats as `pending` via
 * paymentSendStatusOrPending (never re-paid — same stance as v1).
 *
 * The marker's paymentHash comes from decoding the bolt11 we are about to
 * pay, with IBEX's own invoice.hash as fallback — same precedence as
 * send-intraledger's marker.
 */
export const paySplitLeg = async ({
  sourceIbexAccountId,
  destinationWalletId,
  cents,
  currency,
  memo,
  onProgress,
}: SplitPayoutArgs & {
  onProgress?: (progress: SplitPayoutProgress) => void
}): Promise<PaymentSendStatus | ApplicationError> => {
  const amount =
    currency === WalletCurrency.Usdt
      ? USDTAmount.usdCents(cents.toString())
      : USDAmount.cents(cents.toString())
  if (amount instanceof Error) return amount

  const invoiceResp = await Ibex.addInvoice({
    accountId: destinationWalletId as IbexAccountId,
    amount,
    memo,
  })
  if (invoiceResp instanceof Error) return invoiceResp
  if (invoiceResp.invoice?.bolt11 === undefined) {
    return new UnexpectedIbexResponse("Bolt11 field not found.")
  }
  const bolt11 = invoiceResp.invoice.bolt11

  // The hash of the bolt11 we are about to pay is authoritative; IBEX's own
  // `invoice.hash` is the fallback when the bolt11 cannot be decoded locally.
  const decoded = decodeInvoice(bolt11)
  const paymentHash =
    decoded instanceof Error ? invoiceResp.invoice.hash : decoded.paymentHash
  if (typeof paymentHash !== "string" || !PaymentHashRegex.test(paymentHash)) {
    return new InternalTransferMarkerError("Could not read recipient invoice hash")
  }

  const recorded = await recordInternalTransferInvoice({
    paymentHash,
    recipientWalletId: destinationWalletId,
    origin: InternalTransferOrigin.Split,
  })
  if (recorded instanceof Error) {
    return new InternalTransferMarkerError(recorded)
  }

  // Everything above moved no money. From here IBEX may debit the shadow.
  onProgress?.({ payInvoiceReached: true })
  const payResp = await Ibex.payInvoice({
    accountId: sourceIbexAccountId as IbexAccountId,
    invoice: bolt11 as Bolt11,
  })
  if (payResp instanceof Error) return payResp

  return paymentSendStatusOrPending(payResp)
}
