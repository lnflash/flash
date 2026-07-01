import {
  cashWalletHistoryWalletIdsForPresentation,
  cashWalletHistoryWalletsForPresentation,
} from "@app/cash-wallet-cutover/presentation"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const accountId = "cash-account-id" as AccountId

const wallet = ({ id, currency }: { id: string; currency: WalletCurrency }): Wallet =>
  ({
    id: id as WalletId,
    accountId,
    currency,
    type: WalletType.Checking,
    onChainAddressIdentifiers: [],
    onChainAddresses: () => [],
    lnurlp: `lnurlp-${id}` as Lnurl,
  }) as Wallet

const btcWallet = wallet({
  id: "11111111-1111-4111-8111-111111111111",
  currency: WalletCurrency.Btc,
})
const legacyUsdWallet = wallet({
  id: "22222222-2222-4222-8222-222222222222",
  currency: WalletCurrency.Usd,
})
const usdtWallet = wallet({
  id: "33333333-3333-4333-8333-333333333333",
  currency: WalletCurrency.Usdt,
})

describe("cash wallet history expansion for presentation", () => {
  const legacyCompatPresentation = {
    wallets: [btcWallet, legacyUsdWallet],
    defaultWalletId: legacyUsdWallet.id,
    legacyUsdWallet,
    activeSettlementWallet: usdtWallet,
  }

  const usdtPresentation = {
    wallets: [btcWallet, usdtWallet],
    defaultWalletId: usdtWallet.id,
    legacyUsdWallet,
    activeSettlementWallet: usdtWallet,
  }

  const preCutoverPresentation = {
    wallets: [btcWallet, legacyUsdWallet],
    defaultWalletId: legacyUsdWallet.id,
    legacyUsdWallet,
    activeSettlementWallet: legacyUsdWallet,
  }

  it("keeps pre-cutover Cash Wallet history on legacy USD only", () => {
    expect(
      cashWalletHistoryWalletIdsForPresentation({
        presentation: preCutoverPresentation,
      }),
    ).toEqual([btcWallet.id, legacyUsdWallet.id])
  })

  it("appends the legacy-compatible USD archive after active USDT history", () => {
    expect(
      cashWalletHistoryWalletIdsForPresentation({
        presentation: legacyCompatPresentation,
      }),
    ).toEqual([btcWallet.id, usdtWallet.id, legacyUsdWallet.id])
  })

  it("expands explicit legacy USD history to active USDT then legacy archive", () => {
    expect(
      cashWalletHistoryWalletIdsForPresentation({
        walletIds: [legacyUsdWallet.id],
        presentation: legacyCompatPresentation,
      }),
    ).toEqual([usdtWallet.id, legacyUsdWallet.id])
  })

  it("expands explicit USDT history to active USDT then legacy archive", () => {
    expect(
      cashWalletHistoryWalletIdsForPresentation({
        walletIds: [usdtWallet.id],
        presentation: usdtPresentation,
      }),
    ).toEqual([usdtWallet.id, legacyUsdWallet.id])
  })

  it("leaves non-cash wallet filters unchanged", () => {
    expect(
      cashWalletHistoryWalletIdsForPresentation({
        walletIds: [btcWallet.id],
        presentation: legacyCompatPresentation,
      }),
    ).toEqual([btcWallet.id])
  })

  it("returns wallet objects for expanded wallet object history calls", () => {
    expect(
      cashWalletHistoryWalletsForPresentation({
        wallets: [legacyUsdWallet],
        presentation: legacyCompatPresentation,
      }),
    ).toEqual([usdtWallet, legacyUsdWallet])
  })
})
