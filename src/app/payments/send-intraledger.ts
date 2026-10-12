import { validateIsBtcWallet, validateIsUsdWallet } from "@app/wallets"
import { usdWalletAmountFromInput } from "@app/wallets/usd-wallet-amount"

import { AccountValidator } from "@domain/accounts"
import { decodeInvoice, PaymentSendStatus } from "@domain/bitcoin/lightning"
import { InternalTransferMarkerError } from "@domain/payment-splits/errors"
import { checkedToWalletId } from "@domain/wallets"
import { MismatchedCurrencyForWalletError } from "@domain/errors"

import { notifyOpsEvent } from "@services/alerts/ops-events"
import { addAttributesToCurrentSpan } from "@services/tracing"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { recordInternalTransferInvoice } from "@services/mongoose/internal-transfer-invoices"

import Ibex from "@services/ibex/client"
import { UnexpectedIbexResponse } from "@services/ibex/errors"
import { paymentSendStatusOrPending } from "@services/ibex/payment-status"

import { withPaymentIdempotency } from "./idempotency"

// Wallet-id intraledger sends are USD/USDT denominated; the unchecked amount
// is in cents (1 USDT = 1 USD).
const usdCentsDisplay = (cents: number) => ({
  value: (Number(cents) / 100).toFixed(2),
  currency: "USD",
})

const notifyIntraledgerSendResult = (
  args: IntraLedgerPaymentSendWalletIdArgs,
  result: PaymentSendStatus | ApplicationError,
  amount?: { value: string; currency: string },
): void => {
  const base = {
    flow: "transfer" as const,
    amount,
    meta: {
      senderWalletId: args.senderWalletId,
      recipientWalletId: args.recipientWalletId,
    },
  }
  if (result instanceof Error) {
    notifyOpsEvent({
      ...base,
      phase: "failed",
      status: "failed",
      error: result.constructor.name,
      meta: { ...base.meta, reason: "error-return" },
    })
  } else if (result === PaymentSendStatus.Failure) {
    notifyOpsEvent({
      ...base,
      phase: "failed",
      status: "failed",
      meta: { ...base.meta, reason: "status-failure" },
    })
  } else if (result === PaymentSendStatus.Pending) {
    notifyOpsEvent({ ...base, phase: "pending", status: "pending" })
  } else {
    notifyOpsEvent({ ...base, phase: "succeeded", status: "success" })
  }
}

const intraledgerPaymentSendWalletId = async ({
  recipientWalletId: uncheckedRecipientWalletId,
  amount: uncheckedAmount,
  memo,
  senderWalletId: uncheckedSenderWalletId,
}: IntraLedgerPaymentSendWalletIdArgs): Promise<PaymentSendStatus | ApplicationError> => {
  const validatedPaymentInputs = await validateIntraledgerPaymentInputs({
    uncheckedSenderWalletId,
    uncheckedRecipientWalletId,
  })
  if (validatedPaymentInputs instanceof Error) return validatedPaymentInputs

  const { senderWallet, recipientWallet } = validatedPaymentInputs

  const { id: recipientWalletId } = recipientWallet

  if (senderWallet.currency !== recipientWallet.currency) {
    return new MismatchedCurrencyForWalletError()
  }

  const amount = usdWalletAmountFromInput(
    uncheckedAmount.toString(),
    senderWallet.currency,
  )
  if (amount instanceof Error) return amount
  const invoiceResp = await Ibex.addInvoice({
    accountId: recipientWalletId,
    amount,
    memo: memo || "flash-to-flash",
  })
  if (invoiceResp instanceof Error) return invoiceResp
  if (invoiceResp.invoice?.bolt11 === undefined)
    return new UnexpectedIbexResponse("Bolt11 field not found.")

  // ENG-653: mark the recipient invoice as internal BEFORE paying it. IBEX
  // binds every addInvoice to the on-receive webhook, so without this marker a
  // system credit (Fygaro top-up, referral payout) or a split payout itself
  // would trigger the recipient's payment splits. Fails closed: if the marker
  // cannot be written nothing is paid, and the error return is left uncached
  // by withPaymentIdempotency, so the same key can be retried.
  const marked = await markInternalTransferInvoice({
    bolt11: invoiceResp.invoice.bolt11,
    ibexHash: invoiceResp.invoice.hash,
    senderWalletId: senderWallet.id,
    recipientWalletId,
  })
  if (marked instanceof Error) return marked

  const payResp = await Ibex.payInvoice({
    accountId: uncheckedSenderWalletId,
    invoice: invoiceResp.invoice.bolt11 as Bolt11,
  })
  if (payResp instanceof Error) return payResp

  // Same payInvoiceV2 response, same reader as every other IBEX send path —
  // this used to be a fourth private dialect of the status switch, and the only
  // one reading the top-level `status` alone. See @services/ibex/payment-status
  // for the field precedence and for why 0 is not "invoice already paid".
  //
  // CONTRACT CHANGE (deliberate, not incidental): an unreadable payInvoiceV2
  // response used to return `UnexpectedIbexResponse` here, which
  // intraledger-usd-payment-send maps to `{ status: "failed" }`. It now reports
  // `pending`, for the double-pay reason documented on
  // paymentSendStatusOrPending — an error return is left uncached by
  // withPaymentIdempotency, so a same-key retry could re-execute the one send
  // whose outcome we do not know. Until flash-mobile#699 lands, the shipped
  // client renders PENDING as a completed conversion, so this rail is
  // fail-open on that one case; the PR body states this and sequences the two.
  const paymentSendStatus = paymentSendStatusOrPending(payResp)

  // flash fork: no longer adding contact on payments
  // if (senderAccount.id !== recipientAccount.id) {
  //   const addContactResult = await addContactsAfterSend({
  //     senderAccount,
  //     recipientAccount,
  //   })
  //   if (addContactResult instanceof Error) {
  //     recordExceptionInCurrentSpan({ error: addContactResult, level: ErrorLevel.Warn })
  //   }
  // }

  return paymentSendStatus
}

const PaymentHashRegex = /^[0-9a-f]{64}$/i

const markInternalTransferInvoice = async ({
  bolt11,
  ibexHash,
  senderWalletId,
  recipientWalletId,
}: {
  bolt11: string
  ibexHash: string | undefined
  senderWalletId: WalletId
  recipientWalletId: WalletId
}): Promise<true | ApplicationError> => {
  // The hash of the bolt11 we are about to pay is authoritative; IBEX's own
  // `invoice.hash` is the fallback when the bolt11 cannot be decoded locally.
  const decoded = decodeInvoice(bolt11)
  const paymentHash = decoded instanceof Error ? ibexHash : decoded.paymentHash
  if (typeof paymentHash !== "string" || !PaymentHashRegex.test(paymentHash)) {
    return new InternalTransferMarkerError("Could not read recipient invoice hash")
  }

  const recorded = await recordInternalTransferInvoice({
    paymentHash,
    senderWalletId,
    recipientWalletId,
    origin: "intraledger",
  })
  if (recorded instanceof Error) return new InternalTransferMarkerError(recorded)
  return true
}

export const intraledgerPaymentSendWalletIdForBtcWallet = async (
  args: IntraLedgerPaymentSendWalletIdArgs,
): Promise<PaymentSendStatus | ApplicationError> =>
  withPaymentIdempotency({
    idempotencyKey: args.idempotencyKey,
    senderWalletId: args.senderWalletId,
    requestFingerprint: `intraledger|${args.recipientWalletId}|${args.amount}`,
    // ENG-573 send guard. Inside the wrapper, so a replayed key never spends
    // attempt budget nor gets re-judged against a moved mid price.
    authorize: args.authorize,
    execute: async () => {
      const validated = await validateIsBtcWallet(args.senderWalletId)
      const result =
        validated instanceof Error
          ? validated
          : await intraledgerPaymentSendWalletId(args)
      notifyIntraledgerSendResult(args, result)
      return result
    },
  })

export const intraledgerPaymentSendWalletIdForUsdWallet = async (
  args: IntraLedgerPaymentSendWalletIdArgs,
): Promise<PaymentSendStatus | ApplicationError> =>
  withPaymentIdempotency({
    idempotencyKey: args.idempotencyKey,
    senderWalletId: args.senderWalletId,
    requestFingerprint: `intraledger|${args.recipientWalletId}|${args.amount}`,
    // ENG-573 send guard — see the BTC wrapper above.
    authorize: args.authorize,
    execute: async () => {
      const validated = await validateIsUsdWallet(args.senderWalletId, {
        includeUsdt: true,
      })
      const result =
        validated instanceof Error
          ? validated
          : await intraledgerPaymentSendWalletId(args)
      notifyIntraledgerSendResult(args, result, usdCentsDisplay(args.amount))
      return result
    },
  })

const validateIntraledgerPaymentInputs = async ({
  uncheckedSenderWalletId,
  uncheckedRecipientWalletId,
}: {
  uncheckedSenderWalletId: string
  uncheckedRecipientWalletId: string
}): Promise<
  | { senderWallet: Wallet; recipientWallet: Wallet; recipientAccount: Account }
  | ApplicationError
> => {
  const senderWalletId = checkedToWalletId(uncheckedSenderWalletId)
  if (senderWalletId instanceof Error) return senderWalletId

  const senderWallet = await WalletsRepository().findById(senderWalletId)
  if (senderWallet instanceof Error) return senderWallet

  const senderAccount = await AccountsRepository().findById(senderWallet.accountId)
  if (senderAccount instanceof Error) return senderAccount

  const senderAccountValidator = AccountValidator(senderAccount).isActive()
  if (senderAccountValidator instanceof Error) return senderAccountValidator

  const recipientWalletId = checkedToWalletId(uncheckedRecipientWalletId)
  if (recipientWalletId instanceof Error) return recipientWalletId

  const recipientWallet = await WalletsRepository().findById(recipientWalletId)
  if (recipientWallet instanceof Error) return recipientWallet

  const recipientAccount = await AccountsRepository().findById(recipientWallet.accountId)
  if (recipientAccount instanceof Error) return recipientAccount

  const recipientAccountValidator = AccountValidator(recipientAccount).isActive()
  if (recipientAccountValidator instanceof Error) return recipientAccountValidator

  addAttributesToCurrentSpan({
    "payment.intraLedger.senderWalletId": senderWalletId,
    "payment.intraLedger.senderWalletCurrency": senderWallet.currency,
    "payment.intraLedger.recipientWalletId": recipientWalletId,
    "payment.intraLedger.recipientWalletCurrency": recipientWallet.currency,
  })

  return {
    senderWallet,
    recipientWallet,
    recipientAccount,
  }
}
