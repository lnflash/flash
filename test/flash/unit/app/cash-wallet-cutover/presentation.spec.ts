import {
  CashWalletMissingLegacyUsdWalletError,
  CashWalletMissingUsdtWalletError,
} from "@app/cash-wallet-cutover/errors"
import {
  cashWalletTransactionWalletIdsForPresentation,
  resolveCashWalletPresentation,
} from "@app/cash-wallet-cutover/presentation"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const wallet = ({ id, currency }: { id: string; currency: WalletCurrency }): Wallet =>
  ({
    id,
    accountId: "account-id",
    type: WalletType.Checking,
    currency,
  }) as Wallet

const legacyUsdWallet = wallet({
  id: "legacy-usd-wallet-id",
  currency: WalletCurrency.Usd,
})
const usdtWallet = wallet({
  id: "usdt-wallet-id",
  currency: WalletCurrency.Usdt,
})
const btcWallet = wallet({
  id: "btc-wallet-id",
  currency: WalletCurrency.Btc,
})

describe("cash wallet presentation resolver", () => {
  it("returns the legacy USD wallet as the active settlement wallet before cutover", () => {
    expect(
      resolveCashWalletPresentation({
        decision: { presentation: "legacy_usd" },
        wallets: [btcWallet, legacyUsdWallet, usdtWallet],
      }),
    ).toEqual({
      wallets: [btcWallet, legacyUsdWallet],
      defaultWalletId: legacyUsdWallet.id,
      legacyUsdWallet,
      activeSettlementWallet: legacyUsdWallet,
    })
  })

  it("presents legacy USD while routing settlement to USDT for old clients after migration", () => {
    expect(
      resolveCashWalletPresentation({
        decision: { presentation: "legacy_usd_compat" },
        wallets: [btcWallet, legacyUsdWallet, usdtWallet],
      }),
    ).toEqual({
      wallets: [btcWallet, legacyUsdWallet],
      defaultWalletId: legacyUsdWallet.id,
      legacyUsdWallet,
      activeSettlementWallet: usdtWallet,
    })
  })

  it("presents the USDT wallet directly for capable clients", () => {
    expect(
      resolveCashWalletPresentation({
        decision: { presentation: "usdt" },
        wallets: [btcWallet, legacyUsdWallet, usdtWallet],
      }),
    ).toEqual({
      wallets: [btcWallet, usdtWallet],
      defaultWalletId: usdtWallet.id,
      legacyUsdWallet,
      activeSettlementWallet: usdtWallet,
    })
  })

  it("returns cutover-state errors for missing presentation wallets", () => {
    expect(
      resolveCashWalletPresentation({
        decision: { presentation: "legacy_usd" },
        wallets: [usdtWallet],
      }),
    ).toBeInstanceOf(CashWalletMissingLegacyUsdWalletError)

    expect(
      resolveCashWalletPresentation({
        decision: { presentation: "legacy_usd_compat" },
        wallets: [legacyUsdWallet],
      }),
    ).toBeInstanceOf(CashWalletMissingUsdtWalletError)
  })
})

describe("cash wallet transaction wallet ids for presentation", () => {
  it("uses the active settlement wallet when defaulting legacy-compatible history", () => {
    expect(
      cashWalletTransactionWalletIdsForPresentation({
        presentation: {
          wallets: [btcWallet, legacyUsdWallet],
          defaultWalletId: legacyUsdWallet.id,
          legacyUsdWallet,
          activeSettlementWallet: usdtWallet,
        },
      }),
    ).toEqual([btcWallet.id, usdtWallet.id])
  })

  it("remaps explicit legacy USD wallet ids to active settlement wallet ids", () => {
    expect(
      cashWalletTransactionWalletIdsForPresentation({
        walletIds: [legacyUsdWallet.id],
        presentation: {
          wallets: [btcWallet, legacyUsdWallet],
          defaultWalletId: legacyUsdWallet.id,
          legacyUsdWallet,
          activeSettlementWallet: usdtWallet,
        },
      }),
    ).toEqual([usdtWallet.id])
  })
})
