import { AccountStatus } from "@domain/accounts"
import { OnchainUsdPaymentValidator } from "@domain/wallets"
import { USDTAmount, WalletCurrency, isValidated } from "@domain/shared"

const account = {
  id: "account-id" as AccountId,
  status: AccountStatus.Active,
} as Account

const usdtWallet = {
  id: "wallet-id" as WalletId,
  accountId: account.id,
  currency: WalletCurrency.Usdt,
} as Wallet

describe("Onchain USD wallet payment validation", () => {
  it("accepts USDT USD wallets", async () => {
    const amount = USDTAmount.smallestUnits("19446") as USDTAmount

    const result = await OnchainUsdPaymentValidator({
      account,
      wallet: usdtWallet,
      accountId: usdtWallet.id as IbexAccountId,
      address: "0xabc" as OnChainAddress,
      amount,
    })

    expect(isValidated(result)).toBe(true)
  })
})
