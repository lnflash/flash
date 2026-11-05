import { getRewardsConfig, OnboardingEarn } from "@config"
import { IPMetadataAuthorizer } from "@domain/accounts-ips/ip-metadata-authorizer"
import { AccountValidator } from "@domain/accounts"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import {
  InvalidIpMetadataError,
  InvalidQuizQuestionIdError,
  InvalidWalletId,
  MismatchedCurrencyForWalletError,
  MissingIPMetadataError,
  NoBtcWalletExistsForAccountError,
  OperationInterruptedError,
  UnauthorizedIPError,
  UnknownRepositoryError,
} from "@domain/errors"
import { InvalidPhoneForRewardError } from "@domain/users/errors"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { PhoneMetadataAuthorizer } from "@domain/users"
import { usdWalletAmountFromInput } from "@app/wallets/usd-wallet-amount"
import { getFunderWalletId } from "@services/ledger/caching"
import {
  AccountsRepository,
  RewardsRepository,
  WalletsRepository,
  UsersRepository,
} from "@services/mongoose"
import { AccountsIpsRepository } from "@services/mongoose/accounts-ips"

import { intraledgerPaymentSendWalletIdForBtcWallet } from "./send-intraledger"

import { SEND_GUARD_NOT_APPLICABLE } from "./send-guard-optout"

export const addEarn = async ({
  quizQuestionId: quizQuestionIdString,
  accountId,
}: {
  quizQuestionId: string
  accountId: AccountId /* AccountId: aid validation */
}): Promise<QuizQuestion | ApplicationError> => {
  const rewardsConfig = getRewardsConfig()

  if (!Object.hasOwn(OnboardingEarn, quizQuestionIdString))
    return new InvalidQuizQuestionIdError()
  const quizQuestionId = quizQuestionIdString as QuizQuestionId

  const amount = OnboardingEarn[quizQuestionId]
  if (!amount) return new InvalidQuizQuestionIdError()

  let funderWalletId: WalletId
  try {
    funderWalletId = await getFunderWalletId()
  } catch {
    return new UnknownRepositoryError("Reward funding wallet unavailable")
  }
  const funderWallet = await WalletsRepository().findById(funderWalletId)
  if (funderWallet instanceof Error) return funderWallet
  if (funderWallet.type !== WalletType.Checking)
    return new InvalidWalletId("Reward funding requires a checking wallet")
  if (funderWallet.currency !== WalletCurrency.Btc)
    return new MismatchedCurrencyForWalletError()
  const funderAccount = await AccountsRepository().findById(funderWallet.accountId)
  if (funderAccount instanceof Error) return funderAccount
  const activeFunder = AccountValidator(funderAccount).isActive()
  if (activeFunder instanceof Error) return activeFunder
  const ownedFunder =
    AccountValidator(funderAccount).validateWalletForAccount(funderWallet)
  if (ownedFunder instanceof Error) return ownedFunder

  const recipientAccount = await AccountsRepository().findById(accountId)
  if (recipientAccount instanceof Error) return recipientAccount
  const activeRecipient = AccountValidator(recipientAccount).isActive()
  if (activeRecipient instanceof Error) return activeRecipient

  const user = await UsersRepository().findById(recipientAccount.kratosUserId)
  if (user instanceof Error) return user

  const validatedPhoneMetadata = PhoneMetadataAuthorizer(
    rewardsConfig.phoneMetadataValidationSettings,
  ).authorize(user.phoneMetadata)

  if (validatedPhoneMetadata instanceof Error) {
    return new InvalidPhoneForRewardError(validatedPhoneMetadata.name)
  }

  const accountIP = await AccountsIpsRepository().findLastByAccountId(recipientAccount.id)
  if (accountIP instanceof Error) return accountIP

  const validatedIPMetadata = IPMetadataAuthorizer(
    rewardsConfig.ipMetadataValidationSettings,
  ).authorize(accountIP.metadata)
  if (validatedIPMetadata instanceof Error) {
    if (validatedIPMetadata instanceof MissingIPMetadataError)
      return new InvalidIpMetadataError(validatedIPMetadata)

    if (validatedIPMetadata instanceof UnauthorizedIPError) return validatedIPMetadata

    return new UnknownRepositoryError("add earn error")
  }

  const recipientWallets = await WalletsRepository().listByAccountId(accountId)
  if (recipientWallets instanceof Error) return recipientWallets

  const recipientBtcWallet = recipientWallets.find(
    (wallet) =>
      wallet.currency === WalletCurrency.Btc && wallet.type === WalletType.Checking,
  )
  if (recipientBtcWallet === undefined) return new NoBtcWalletExistsForAccountError()
  const ownedRecipient =
    AccountValidator(recipientAccount).validateWalletForAccount(recipientBtcWallet)
  if (ownedRecipient instanceof Error) return ownedRecipient
  const recipientWalletId = recipientBtcWallet.id

  // Preflight the same amount adapter used by send-intraledger BEFORE claiming
  // a lesson. The current rail accepts only USD/USDT, so BTC rewards remain
  // unavailable instead of consuming eligibility on a guaranteed failure.
  // External SDK wallet IDs are never IBEX destination account IDs.
  const supportedAmount = usdWalletAmountFromInput(
    amount.toString(),
    funderWallet.currency,
  )
  if (supportedAmount instanceof Error) return supportedAmount

  const shouldGiveReward = await RewardsRepository(accountId).add(quizQuestionId)
  if (shouldGiveReward instanceof Error) return shouldGiveReward

  const payment = await intraledgerPaymentSendWalletIdForBtcWallet({
    senderWalletId: funderWalletId,
    recipientWalletId,
    amount,
    memo: quizQuestionId,
    senderAccount: funderAccount,
    // A quiz reward is a system credit out of the funder wallet, not a
    // user-initiated send: see SEND_GUARD_NOT_APPLICABLE.
    authorize: SEND_GUARD_NOT_APPLICABLE,
  })
  if (payment instanceof Error) return payment
  if (payment.value !== PaymentSendStatus.Success.value)
    return new OperationInterruptedError("Reward payment settlement is not confirmed")

  return { id: quizQuestionId, earnAmount: amount }
}
