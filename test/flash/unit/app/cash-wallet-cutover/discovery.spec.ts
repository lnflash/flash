import { classifyCashWalletsForCutover } from "@app/cash-wallet-cutover/discovery"

import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const account = (defaultWalletId: WalletId): Account => ({
  id: "account-id" as AccountId,
  uuid: "account-uuid" as AccountUuid,
  createdAt: new Date("2026-05-20T00:00:00Z"),
  defaultWalletId,
  username: "username" as Username,
  npub: "npub" as Npub,
  level: 1 as AccountLevel,
  status: "active" as AccountStatus,
  statusHistory: [{ status: "active" as AccountStatus, timestamp: new Date() }],
  title: "" as BusinessMapTitle,
  coordinates: undefined as Coordinates,
  contactEnabled: false,
  contacts: [],
  withdrawFee: 0 as Satoshis,
  isEditor: false,
  notificationSettings: { push: { enabled: true, disabledCategories: [] } },
  quizQuestions: [],
  quiz: [],
  kratosUserId: "user-id" as UserId,
  displayCurrency: "USD" as DisplayCurrency,
})

const wallet = ({
  id,
  currency,
  type = WalletType.Checking,
}: {
  id: WalletId
  currency: WalletCurrency
  type?: WalletType
}): Wallet => ({
  id,
  accountId: "account-id" as AccountId,
  type,
  currency,
  onChainAddressIdentifiers: [],
  onChainAddresses: () => [],
  lnurlp: "lnurl" as Lnurl,
})

describe("cash wallet cutover discovery", () => {
  const legacyUsdWallet = wallet({
    id: "legacy-usd-wallet-id" as WalletId,
    currency: WalletCurrency.Usd,
  })
  const destinationUsdtWallet = wallet({
    id: "usdt-wallet-id" as WalletId,
    currency: WalletCurrency.Usdt,
  })

  it("classifies accounts whose default still points to legacy USD", () => {
    const result = classifyCashWalletsForCutover({
      account: account("legacy-usd-wallet-id" as WalletId),
      wallets: [legacyUsdWallet, destinationUsdtWallet],
    })

    expect(result).toMatchObject({
      status: "legacy_default",
      accountId: "account-id",
      accountUuid: "account-uuid",
      legacyUsdWalletId: "legacy-usd-wallet-id",
      destinationUsdtWalletId: "usdt-wallet-id",
      previousDefaultWalletId: "legacy-usd-wallet-id",
    })
  })

  it("classifies accounts already defaulting to ETH-USDT", () => {
    const result = classifyCashWalletsForCutover({
      account: account("usdt-wallet-id" as WalletId),
      wallets: [legacyUsdWallet, destinationUsdtWallet],
    })

    expect(result).toMatchObject({
      status: "already_usdt",
      legacyUsdWalletId: "legacy-usd-wallet-id",
      destinationUsdtWalletId: "usdt-wallet-id",
      previousDefaultWalletId: "usdt-wallet-id",
    })
  })

  it("classifies legacy USD wallets that are no longer the default as residual", () => {
    const result = classifyCashWalletsForCutover({
      account: account("btc-wallet-id" as WalletId),
      wallets: [legacyUsdWallet, destinationUsdtWallet],
    })

    expect(result).toMatchObject({ status: "residual_legacy_usd" })
  })

  it("surfaces accounts that cannot be planned because a required cash wallet is missing", () => {
    expect(
      classifyCashWalletsForCutover({
        account: account("legacy-usd-wallet-id" as WalletId),
        wallets: [legacyUsdWallet],
      }),
    ).toMatchObject({ status: "missing_destination_usdt" })

    expect(
      classifyCashWalletsForCutover({
        account: account("usdt-wallet-id" as WalletId),
        wallets: [destinationUsdtWallet],
      }),
    ).toMatchObject({ status: "missing_legacy_usd" })
  })
})
