import { NETWORK } from "@config"

import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { checkedToOnChainAddress } from "@domain/bitcoin/onchain"
import { UnsupportedCurrencyError } from "@domain/errors"
import { ErrorLevel, USDAmount } from "@domain/shared"
import { OnchainUsdPaymentValidator } from "@domain/wallets"

import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { recordExceptionInCurrentSpan } from "@services/tracing"

import Ibex from "@services/ibex/client"
import { IbexError, UnexpectedIbexResponse } from "@services/ibex/errors"
import IbexAdaptor from "@services/ibex/DomainAdaptor"

type PayOnChainByWalletIdWithoutCurrencyArgs = {
  senderWalletId: WalletId
  senderAccount: Account
  address: string
  speed: PayoutSpeed
  memo: string | null
  amount?: number | FractionalCentAmount | USDAmount
}

type PayOnChainByUsdArgs = PayOnChainByWalletIdWithoutCurrencyArgs & {
  amount: USDAmount
}

type PayOnChainByWalletIdForUsdWalletArgs = PayOnChainByWalletIdWithoutCurrencyArgs & {
  amount: number | FractionalCentAmount | USDAmount
}

/*
 * The following code has been changed for Flash as follows:
 *
 * 1. Intraledger payments -
 *     Ibex does not allow us to check if address is Ibex owned,
 *     so we are currently unable to distinguish intraledger vs external
 *     To do so, we would need to track the address ourselves in mongo
 * 2. Rate conversion (BTC-USD) - Ibex handles
 * 3. Volume limit checks - either need to reference an internal ledger or,
 *   get recent trx volume from Ibex
 *
 * To reintroduce, see the Galoy codebase:
 */
export const payOnChainByWalletId = async ({
  senderAccount,
  senderWalletId,
  amount,
  address,
}: PayOnChainByUsdArgs): Promise<PayOnChainByWalletIdResult | Error> => {
  // For testing purposes, would be nice to extract these functions
  const latestAccountState = await AccountsRepository().findById(senderAccount.id)
  if (latestAccountState instanceof Error) return latestAccountState

  const senderWallet = await WalletsRepository().findById(senderWalletId as WalletId)
  if (senderWallet instanceof Error) return senderWallet

  const checkedAddress = checkedToOnChainAddress({
    network: NETWORK,
    value: address,
  })
  if (checkedAddress instanceof Error) return checkedAddress

  const args = {
    accountId: senderWalletId as IbexAccountId,
    address: checkedAddress,
    amount,
  }

  const validationResult = await OnchainUsdPaymentValidator({
    ...args,
    account: latestAccountState,
    wallet: senderWallet,
  })
  if (validationResult instanceof Error) return validationResult

  const resp = await Ibex.sendOnchain(args)
  if (resp instanceof IbexError) return resp

  let status = IbexAdaptor.toPaymentSendStatus(resp.status)
  if (status instanceof UnexpectedIbexResponse) {
    recordExceptionInCurrentSpan({
      error: status,
      level: ErrorLevel.Warn,
    })
    status = PaymentSendStatus.Pending
  }
  return {
    status,
    payoutId: resp.transactionHub?.id as PayoutId,
  }
}

// FLASH FORK: BTC amount is not supported
export const payOnChainByWalletIdForBtcWallet = async (
  args: PayOnChainByWalletIdWithoutCurrencyArgs,
): Promise<PayOnChainByWalletIdResult | ApplicationError> => {
  return new UnsupportedCurrencyError(
    `BTC amount is not supported for wallet ${args.senderWalletId}`,
  )
}

export const payOnChainByWalletIdForUsdWallet = async (
  args: PayOnChainByWalletIdForUsdWalletArgs,
): Promise<PayOnChainByWalletIdResult | ApplicationError> => {
  return payOnChainByWalletId(args as PayOnChainByUsdArgs)
}

export const payOnChainByWalletIdForUsdWalletAndBtcAmount = async (
  args: PayOnChainByWalletIdWithoutCurrencyArgs,
): Promise<PayOnChainByWalletIdResult | ApplicationError> => {
  return new UnsupportedCurrencyError(
    `BTC amount is not supported for wallet ${args.senderWalletId}`,
  )
}
