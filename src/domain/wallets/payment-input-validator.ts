import {
  BtcAmount,
  USDAmount,
  ValidationError,
  isActiveAccount,
  isUsdWallet,
  validator,
  walletBelongsToAccount,
} from "@domain/shared"
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

type SendOnchainArgsWithContext = SendOnchainArgs & { wallet: Wallet, account: Account }

export const OnchainUsdPaymentValidator = validator<SendOnchainArgsWithContext>([
  isUsdWallet,
  isActiveAccount,
  walletBelongsToAccount,
  checkOnchainMin,
])