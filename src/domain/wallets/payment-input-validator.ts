import { USDAmount, ValidationError, isUsdWallet, validator } from "@domain/shared"
import { isActiveAccount, walletBelongsToAccount } from "@domain/accounts"
import { InvalidAccountStatusError, SelfPaymentError } from "@domain/errors"
import { InvalidBtcPaymentAmountError } from "@domain/shared/errors"
import { SendOnchainArgs } from "@services/ibex/types"

// Ibex does not allow us to check if address is Ibex owned,
// const checkForSelfPayment = (o: { senderWallet: Wallet, recipientWallet: Wallet }) => {
//   if (o.recipientWallet.id === o.senderWallet.id) return new SelfPaymentError()
//   else return true
// }

const checkOnchainMin = async (o: { amount: USDAmount }) => {
  // TODO: Currently relying on Ibex to enforce dust limits
  // const { dustThreshold } = getOnChainWalletConfig()
  // const minBtc = BtcAmount.sats(dustThreshold.toString())
  // const btcPrice = await PriceService().getUsdCentRealTimePrice(_)
  // if (btcPrice instanceof PriceServiceError) return new ValidationError(btcPrice)
  // const minUsd = minBtc.convertAtRate(MoneyAmount.from("50000", WalletCurrency.Usd))
  const minUsd = USDAmount.ZERO
  return o.amount.isGreaterThan(minUsd)
    ? true
    : new ValidationError(`Amount must be greater than ${minUsd.asDollars()}`)
}

type SendOnchainArgsWithContext = SendOnchainArgs & { wallet: Wallet; account: Account }

type LegacyValidatePaymentInputArgs = {
  amount: number
  amountCurrency: WalletCurrency
  senderWalletId: WalletId
  senderAccount: Account
  recipientWalletId?: WalletId
}

export const OnchainUsdPaymentValidator = validator<SendOnchainArgsWithContext>([
  isUsdWallet,
  isActiveAccount,
  walletBelongsToAccount,
  checkOnchainMin,
])
export const PaymentInputValidator = (getWalletFn: PaymentInputValidatorConfig) => ({
  validatePaymentInput: async ({
    amount,
    amountCurrency,
    senderWalletId,
    senderAccount,
    recipientWalletId,
  }: LegacyValidatePaymentInputArgs) => {
    if (senderAccount.status !== "active") return new InvalidAccountStatusError()
    if (amountCurrency === "BTC" && amount <= 0) return new InvalidBtcPaymentAmountError()

    const senderWallet = await getWalletFn(senderWalletId)
    if (senderWallet instanceof Error) return senderWallet

    const recipientWallet = recipientWalletId
      ? await getWalletFn(recipientWalletId)
      : undefined
    if (recipientWallet instanceof Error) return recipientWallet
    if (recipientWallet && recipientWallet.id === senderWallet.id)
      return new SelfPaymentError()

    return {
      amount: { amount: BigInt(amount), currency: amountCurrency },
      senderWallet,
      recipientWallet,
    }
  },
})
