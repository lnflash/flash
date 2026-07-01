import { validateIsBtcWallet, validateIsUsdWallet } from "@app/wallets"
import { usdWalletAmountFromInput } from "@app/wallets/usd-wallet-amount"

import { AccountValidator } from "@domain/accounts"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { checkedToWalletId } from "@domain/wallets"
import { MismatchedCurrencyForWalletError } from "@domain/errors"

import { addAttributesToCurrentSpan } from "@services/tracing"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"

import Ibex from "@services/ibex/client"
import { UnexpectedIbexResponse } from "@services/ibex/errors"

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

  const payResp = await Ibex.payInvoice({
    accountId: uncheckedSenderWalletId,
    invoice: invoiceResp.invoice.bolt11 as Bolt11,
  })
  if (payResp instanceof Error) return payResp

  // https://docs.ibexmercado.com/reference/flow-1#payment-status
  let paymentSendStatus: PaymentSendStatus
  switch (payResp.status) {
    case 1:
      paymentSendStatus = PaymentSendStatus.Pending
      break
    case 2:
      paymentSendStatus = PaymentSendStatus.Success
      break
    case 3:
      paymentSendStatus = PaymentSendStatus.Failure
      break
    case 0:
      return new UnexpectedIbexResponse("Invoice already paid")
    default:
      return new UnexpectedIbexResponse(
        `StatusId (${payResp.status}) not in documentation`,
      )
  }

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

export const intraledgerPaymentSendWalletIdForBtcWallet = async (
  args: IntraLedgerPaymentSendWalletIdArgs,
): Promise<PaymentSendStatus | ApplicationError> => {
  const validated = await validateIsBtcWallet(args.senderWalletId)
  return validated instanceof Error ? validated : intraledgerPaymentSendWalletId(args)
}

export const intraledgerPaymentSendWalletIdForUsdWallet = async (
  args: IntraLedgerPaymentSendWalletIdArgs,
): Promise<PaymentSendStatus | ApplicationError> => {
  const validated = await validateIsUsdWallet(args.senderWalletId, { includeUsdt: true })
  return validated instanceof Error ? validated : intraledgerPaymentSendWalletId(args)
}

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
