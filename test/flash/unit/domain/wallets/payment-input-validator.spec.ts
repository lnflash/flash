import crypto from "crypto"

import { UsdDisplayCurrency } from "@domain/fiat"
import { AccountLevel, AccountStatus } from "@domain/accounts"
import { InactiveAccountError } from "@domain/errors"
import { ValidationError } from "@domain/shared"
import { OnchainUsdPaymentValidator, WalletType } from "@domain/wallets"
import { WalletCurrency, USDAmount, isValidated } from "@domain/shared"

describe("OnchainUsdPaymentValidator", () => {
  const dummyAccount: Account = {
    id: crypto.randomUUID() as AccountId,
    uuid: crypto.randomUUID() as AccountUuid,
    createdAt: new Date(),
    username: "username" as Username,
    defaultWalletId: "senderWalletId" as WalletId,
    withdrawFee: 0 as Satoshis,
    level: AccountLevel.One,
    status: AccountStatus.Active,
    statusHistory: [{ status: AccountStatus.Active }],
    title: "" as BusinessMapTitle,
    coordinates: {
      latitude: 0,
      longitude: 0,
    },
    notificationSettings: {
      push: {
        enabled: true,
        disabledCategories: [],
      },
    },
    contactEnabled: true,
    contacts: [],
    isEditor: false,
    quizQuestions: [],
    quiz: [],
    kratosUserId: "kratosUserId" as UserId,
    displayCurrency: UsdDisplayCurrency,
    npub: "npub..." as Npub
  }

  const dummySenderWallet: Wallet = {
    id: crypto.randomUUID() as WalletId,
    accountId: dummyAccount.id,
    type: WalletType.Checking,
    currency: WalletCurrency.Usd,
    onChainAddressIdentifiers: [],
    onChainAddresses: () => [],
    lnurlp: "LNURLP" as Lnurl
  }

  it("returns the correct types when everything is valid", async () => {
    const usd = USDAmount.cents(5n)
    if (usd instanceof Error) return usd
    const result = OnchainUsdPaymentValidator({ 
      wallet: dummySenderWallet,
      account: dummyAccount,
      accountId: dummySenderWallet.id,
      amount: usd,
      address: "bc1q..." as OnChainAddress
    })
    if (result instanceof Error) throw result

    console.log(await result)
    expect(isValidated(await result)).toBe(true)
  })

  it("Fails on invalid amount", async () => {
    const usd = USDAmount.cents(0n)
    if (usd instanceof Error) throw usd
    const result = await OnchainUsdPaymentValidator({
      wallet: dummySenderWallet,
      account: dummyAccount,
      accountId: dummySenderWallet.id,
      amount: usd,
      address: "bc1q..." as OnChainAddress
    })
    expect(Array.isArray(result) && result[0]).toBeInstanceOf(ValidationError)
  })

  it("Fails if the account is not active", async () => {
    const usd = USDAmount.cents(5n)
    if (usd instanceof Error) throw usd
    const result = await OnchainUsdPaymentValidator({
      wallet: dummySenderWallet,
      account: {
        ...dummyAccount,
        status: AccountStatus.Locked,
      },
      accountId: dummySenderWallet.id,
      amount: usd,
      address: "bc1q..." as OnChainAddress
    })
    expect(Array.isArray(result) && result[0]).toBeInstanceOf(InactiveAccountError)
  })
})
