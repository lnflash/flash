import { WalletCurrency } from "@domain/shared"

import { CashWalletCutoverDecision } from "./guard"
import {
  CashWalletMissingLegacyUsdWalletError,
  CashWalletMissingUsdtWalletError,
} from "./errors"

export type CashWalletPresentationResult = {
  wallets: Wallet[]
  defaultWalletId: WalletId
  legacyUsdWallet?: Wallet
  activeSettlementWallet: Wallet
}

export const resolveCashWalletPresentation = ({
  decision,
  wallets,
}: {
  decision: CashWalletCutoverDecision
  wallets: Wallet[]
}): CashWalletPresentationResult | ApplicationError => {
  const legacyUsdWallet = wallets.find((wallet) => wallet.currency === WalletCurrency.Usd)
  const usdtWallet = wallets.find((wallet) => wallet.currency === WalletCurrency.Usdt)
  const nonCashWallets = wallets.filter(
    (wallet) =>
      wallet.currency !== WalletCurrency.Usd && wallet.currency !== WalletCurrency.Usdt,
  )

  if (decision.presentation === "usdt") {
    if (!usdtWallet) return new CashWalletMissingUsdtWalletError()

    return {
      wallets: [...nonCashWallets, usdtWallet],
      defaultWalletId: usdtWallet.id,
      legacyUsdWallet,
      activeSettlementWallet: usdtWallet,
    }
  }

  if (!legacyUsdWallet) return new CashWalletMissingLegacyUsdWalletError()

  if (decision.presentation === "legacy_usd_compat") {
    if (!usdtWallet) return new CashWalletMissingUsdtWalletError()

    return {
      wallets: [...nonCashWallets, legacyUsdWallet],
      defaultWalletId: legacyUsdWallet.id,
      legacyUsdWallet,
      activeSettlementWallet: usdtWallet,
    }
  }

  return {
    wallets: [...nonCashWallets, legacyUsdWallet],
    defaultWalletId: legacyUsdWallet.id,
    legacyUsdWallet,
    activeSettlementWallet: legacyUsdWallet,
  }
}

export const cashWalletTransactionWalletIdsForPresentation = ({
  walletIds,
  presentation,
}: {
  walletIds?: WalletId[]
  presentation: CashWalletPresentationResult
}): WalletId[] => {
  const selectedWalletIds = walletIds ?? presentation.wallets.map((wallet) => wallet.id)

  if (!presentation.legacyUsdWallet) return selectedWalletIds

  return Array.from(
    new Set(
      selectedWalletIds.map((walletId) =>
        walletId === presentation.legacyUsdWallet?.id
          ? presentation.activeSettlementWallet.id
          : walletId,
      ),
    ),
  )
}
