import {
  USDAmount,
  USDTAmount,
  ValidationError,
  WalletCurrency,
  validator,
} from "@domain/shared"
import { isActiveAccount, walletBelongsToAccount } from "@domain/accounts"
import { SendOnchainArgs } from "@services/ibex/types"

// Ibex does not allow us to check if address is Ibex owned,
// const checkForSelfPayment = (o: { senderWallet: Wallet, recipientWallet: Wallet }) => {
//   if (o.recipientWallet.id === o.senderWallet.id) return new SelfPaymentError()
//   else return true
// }

const isUsdWalletForOnChainPayment = async (o: { wallet: Wallet }) => {
  if (
    o.wallet.currency === WalletCurrency.Usd ||
    o.wallet.currency === WalletCurrency.Usdt
  ) {
    return true
  }
  return new ValidationError(`Expected USD, got ${o.wallet.currency}`)
}

const checkOnchainMin = async (o: { amount: USDAmount | USDTAmount }) => {
  // TODO: Currently relying on Ibex to enforce dust limits
  // const { dustThreshold } = getOnChainWalletConfig()
  // const minBtc = BtcAmount.sats(dustThreshold.toString())
  // const btcPrice = await PriceService().getUsdCentRealTimePrice(_)
  // if (btcPrice instanceof PriceServiceError) return new ValidationError(btcPrice)
  // const minUsd = minBtc.convertAtRate(MoneyAmount.from("50000", WalletCurrency.Usd))
  const isGreaterThanZero =
    o.amount instanceof USDTAmount
      ? o.amount.isGreaterThan(USDTAmount.ZERO)
      : o.amount.isGreaterThan(USDAmount.ZERO)

  return isGreaterThanZero ? true : new ValidationError("Amount must be greater than 0")
}

type SendOnchainArgsWithContext = SendOnchainArgs & { wallet: Wallet; account: Account }

export const OnchainUsdPaymentValidator = validator<SendOnchainArgsWithContext>([
  isUsdWalletForOnChainPayment,
  isActiveAccount,
  walletBelongsToAccount,
  checkOnchainMin,
])
