import { getCallbackServiceConfig, getValuesToSkipProbe } from "@config"

import {
  btcFromUsdMidPriceFn,
  getCurrentPriceAsDisplayPriceRatio,
  usdFromBtcMidPriceFn,
} from "@app/prices"
import { removeDeviceTokens } from "@app/users/remove-device-tokens"
import { validateIsBtcWallet, validateIsUsdWallet } from "@app/wallets"

import {
  InvalidLightningPaymentFlowBuilderStateError,
  LightningPaymentFlowBuilder,
  toDisplayBaseAmount,
} from "@domain/payments"
import { AccountLevel, AccountValidator } from "@domain/accounts"
import { DisplayAmountsConverter } from "@domain/fiat"
import { checkedToUsdPaymentAmount, ErrorLevel, paymentAmountFromNumber, ValidationError, WalletCurrency } from "@domain/shared"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { ResourceExpiredLockServiceError } from "@domain/lock"
import { checkedToWalletId, SettlementMethod } from "@domain/wallets"
import { DeviceTokensNotRegisteredNotificationsServiceError } from "@domain/notifications"

import { LockService } from "@services/lock"
import { LedgerService } from "@services/ledger"
import * as LedgerFacade from "@services/ledger/facade"
import { DealerPriceService } from "@services/dealer-price"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"
import {
  AccountsRepository,
  WalletsRepository,
  UsersRepository,
} from "@services/mongoose"
import { NotificationsService } from "@services/notifications"

import { CallbackService } from "@services/svix"

import { CallbackEventType } from "@domain/callback"

import {
  getPriceRatioForLimits,
  checkIntraledgerLimits,
  checkTradeIntraAccountLimits,
  addContactsAfterSend,
} from "./helpers"

import Ibex from "@services/ibex/client"
import USDollars from "@services/ibex/currencies/USDollars"
import { UnexpectedIbexResponse } from "@services/ibex/errors"

const dealer = DealerPriceService()

const intraledgerPaymentSendWalletId = async ({
  recipientWalletId: uncheckedRecipientWalletId,
  senderAccount,
  amount: uncheckedAmount,
  memo,
  senderWalletId: uncheckedSenderWalletId,
}: IntraLedgerPaymentSendWalletIdArgs): Promise<PaymentSendStatus | ApplicationError> => {
  const validatedPaymentInputs = await validateIntraledgerPaymentInputs({
    uncheckedSenderWalletId,
    uncheckedRecipientWalletId,
  })
  if (validatedPaymentInputs instanceof Error) return validatedPaymentInputs

  const { senderWallet, recipientWallet, recipientAccount } = validatedPaymentInputs

  const { id: recipientWalletId, currency: recipientWalletCurrency } = recipientWallet
  const {
    id: recipientAccountId,
    username: recipientUsername,
    kratosUserId: recipientUserId,
  } = recipientAccount

  const amount = checkedToUsdPaymentAmount(uncheckedAmount) 
  if (amount instanceof ValidationError) return amount
  const invoiceResp = await Ibex.addInvoice({ 
    accountId: recipientWalletId,
    amount: USDollars.fromAmount(amount), 
    memo: memo || "flash-to-flash",
  })
  if (invoiceResp instanceof Error) return invoiceResp
  if (invoiceResp.invoice?.bolt11 === undefined) return new UnexpectedIbexResponse("Bolt11 field not found.")

  const payResp = await Ibex.payInvoice({
    accountId: uncheckedSenderWalletId,
    invoice: invoiceResp.invoice.bolt11 as Bolt11,
  })
  if (payResp instanceof Error) return payResp

  // https://docs.ibexmercado.com/reference/flow-1#payment-status
  let paymentSendStatus: PaymentSendStatus 
  switch(payResp.status) {
    case 1:
      paymentSendStatus = PaymentSendStatus.Pending 
      break;
    case 2:
      paymentSendStatus = PaymentSendStatus.Success 
      break;
    case 3:
      paymentSendStatus = PaymentSendStatus.Failure
      break;
    case 0: 
      return new UnexpectedIbexResponse("Invoice already paid")
    default:
      return new UnexpectedIbexResponse(`StatusId (${payResp.status}) not in documenation`)
  }

  if (senderAccount.id !== recipientAccount.id) {
    const addContactResult = await addContactsAfterSend({
      senderAccount,
      recipientAccount,
    })
    if (addContactResult instanceof Error) {
      recordExceptionInCurrentSpan({ error: addContactResult, level: ErrorLevel.Warn })
    }
  }

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
  const validated = await validateIsUsdWallet(args.senderWalletId)
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

  const senderAccountValidator = AccountValidator(senderAccount)
  if (senderAccountValidator instanceof Error) return senderAccountValidator

  const recipientWalletId = checkedToWalletId(uncheckedRecipientWalletId)
  if (recipientWalletId instanceof Error) return recipientWalletId

  const recipientWallet = await WalletsRepository().findById(recipientWalletId)
  if (recipientWallet instanceof Error) return recipientWallet

  const recipientAccount = await AccountsRepository().findById(recipientWallet.accountId)
  if (recipientAccount instanceof Error) return recipientAccount

  const recipientAccountValidator = AccountValidator(recipientAccount)
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

const executePaymentViaIntraledger = async <
  S extends WalletCurrency,
  R extends WalletCurrency,
>({
  paymentFlow,
  senderAccount,
  senderWallet,
  recipientAccount,
  recipientWallet,
  memo,
}: {
  paymentFlow: PaymentFlow<S, R>
  senderAccount: Account
  senderWallet: WalletDescriptor<S>
  recipientAccount: Account
  recipientWallet: WalletDescriptor<R>
  memo: string | null
}): Promise<PaymentSendStatus | ApplicationError> => {
  addAttributesToCurrentSpan({
    "payment.settlement_method": SettlementMethod.IntraLedger,
  })

  const priceRatioForLimits = await getPriceRatioForLimits(paymentFlow.paymentAmounts())
  if (priceRatioForLimits instanceof Error) return priceRatioForLimits

  const checkLimits =
    senderWallet.accountId === recipientWallet.accountId
      ? checkTradeIntraAccountLimits
      : checkIntraledgerLimits
  const limitCheck = await checkLimits({
    amount: paymentFlow.usdPaymentAmount,
    accountId: senderWallet.accountId,
    priceRatio: priceRatioForLimits,
  })
  if (limitCheck instanceof Error) return limitCheck

  const { walletDescriptor: recipientWalletDescriptor, recipientUsername } =
    paymentFlow.recipientDetails()
  if (!recipientWalletDescriptor) {
    return new InvalidLightningPaymentFlowBuilderStateError(
      "Expected recipient details missing",
    )
  }
  const { currency: recipientWalletCurrency } = recipientWalletDescriptor

  return LockService().lockWalletId(senderWallet.id, async (signal) => {
    const balance = await LedgerService().getWalletBalanceAmount(senderWallet)
    if (balance instanceof Error) return balance

    const balanceCheck = paymentFlow.checkBalanceForSend(balance)
    if (balanceCheck instanceof Error) return balanceCheck

    const { displayCurrency: senderDisplayCurrency } = senderAccount
    const senderDisplayPriceRatio = await getCurrentPriceAsDisplayPriceRatio({
      currency: senderDisplayCurrency,
    })
    if (senderDisplayPriceRatio instanceof Error) return senderDisplayPriceRatio
    const { displayAmount: senderDisplayAmount, displayFee: senderDisplayFee } =
      DisplayAmountsConverter(senderDisplayPriceRatio).convert(paymentFlow)

    const recipientDisplayPriceRatio = await getCurrentPriceAsDisplayPriceRatio({
      currency: recipientAccount.displayCurrency,
    })
    if (recipientDisplayPriceRatio instanceof Error) return recipientDisplayPriceRatio
    const { displayAmount: recipientDisplayAmount, displayFee: recipientDisplayFee } =
      DisplayAmountsConverter(recipientDisplayPriceRatio).convert(paymentFlow)

    if (signal.aborted) {
      return new ResourceExpiredLockServiceError(signal.error?.message)
    }

    let metadata:
      | AddWalletIdIntraledgerSendLedgerMetadata
      | AddWalletIdTradeIntraAccountLedgerMetadata
    let additionalDebitMetadata: {
      [key: string]: Username | DisplayCurrencyBaseAmount | DisplayCurrency | undefined
    } = {}
    let additionalCreditMetadata: {
      [key: string]: DisplayCurrencyBaseAmount | DisplayCurrency | undefined
    }
    let additionalInternalMetadata: {
      [key: string]: DisplayCurrencyBaseAmount | DisplayCurrency | undefined
    } = {}
    if (senderWallet.accountId === recipientWallet.accountId) {
      ;({
        metadata,
        debitAccountAdditionalMetadata: additionalDebitMetadata,
        creditAccountAdditionalMetadata: additionalCreditMetadata,
        internalAccountsAdditionalMetadata: additionalInternalMetadata,
      } = LedgerFacade.WalletIdTradeIntraAccountLedgerMetadata({
        paymentAmounts: paymentFlow,

        senderAmountDisplayCurrency: toDisplayBaseAmount(senderDisplayAmount),
        senderFeeDisplayCurrency: toDisplayBaseAmount(senderDisplayFee),
        senderDisplayCurrency: senderDisplayCurrency,

        memoOfPayer: memo || undefined,
      }))
    } else {
      ;({
        metadata,
        debitAccountAdditionalMetadata: additionalDebitMetadata,
        creditAccountAdditionalMetadata: additionalCreditMetadata,
        internalAccountsAdditionalMetadata: additionalInternalMetadata,
      } = LedgerFacade.WalletIdIntraledgerLedgerMetadata({
        paymentAmounts: paymentFlow,

        senderAmountDisplayCurrency: toDisplayBaseAmount(senderDisplayAmount),
        senderFeeDisplayCurrency: toDisplayBaseAmount(senderDisplayFee),
        senderDisplayCurrency: senderDisplayCurrency,

        recipientAmountDisplayCurrency: toDisplayBaseAmount(recipientDisplayAmount),
        recipientFeeDisplayCurrency: toDisplayBaseAmount(recipientDisplayFee),
        recipientDisplayCurrency: recipientAccount.displayCurrency,

        memoOfPayer: memo || undefined,
        senderUsername: senderAccount.username,
        recipientUsername,
      }))
    }

    const recipientWalletDescriptor = paymentFlow.recipientWalletDescriptor()
    if (recipientWalletDescriptor === undefined)
      return new InvalidLightningPaymentFlowBuilderStateError()

    const journal = await LedgerFacade.recordIntraledger({
      description: paymentFlow.descriptionFromInvoice,
      amount: {
        btc: paymentFlow.btcPaymentAmount,
        usd: paymentFlow.usdPaymentAmount,
      },
      senderWalletDescriptor: paymentFlow.senderWalletDescriptor(),
      recipientWalletDescriptor,
      metadata,
      additionalDebitMetadata,
      additionalCreditMetadata,
      additionalInternalMetadata,
    })
    if (journal instanceof Error) return journal

    const totalSendAmounts = paymentFlow.totalAmountsForPayment()

    const recipientUser = await UsersRepository().findById(recipientAccount.kratosUserId)
    if (recipientUser instanceof Error) return recipientUser

    let amount = totalSendAmounts.btc.amount
    if (recipientWalletCurrency === WalletCurrency.Usd) {
      amount = totalSendAmounts.usd.amount
    }

    const result = await NotificationsService().intraLedgerTxReceived({
      recipientAccountId: recipientWallet.accountId,
      recipientWalletId: recipientWallet.id,
      recipientDeviceTokens: recipientUser.deviceTokens,
      recipientLanguage: recipientUser.language,
      paymentAmount: { amount, currency: recipientWallet.currency },
      recipientNotificationSettings: recipientAccount.notificationSettings,
      displayPaymentAmount: recipientDisplayAmount,
    })

    if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
      await removeDeviceTokens({ userId: recipientUser.id, deviceTokens: result.tokens })
    }

    if (
      recipientAccount.level === AccountLevel.One ||
      recipientAccount.level === AccountLevel.Two
    ) {
      const callbackService = CallbackService(getCallbackServiceConfig())
      callbackService.sendMessage({
        accountUuid: recipientAccount.uuid,
        eventType: CallbackEventType.ReceiveIntraledger,
        payload: {
          // FIXME: [0] might not be correct
          txid: journal.transactionIds[0],
        },
      })
    }

    return PaymentSendStatus.Success
  })
}
