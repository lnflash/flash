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

const cashWalletHistoryWalletIds = ({
  selectedWalletIds,
  presentation,
}: {
  selectedWalletIds: WalletId[]
  presentation: CashWalletPresentationResult
}): WalletId[] => {
  const { legacyUsdWallet, activeSettlementWallet } = presentation
  if (!legacyUsdWallet) return Array.from(new Set(selectedWalletIds))

  const cashWalletIds = new Set([legacyUsdWallet.id, activeSettlementWallet.id])

  return Array.from(
    new Set(
      selectedWalletIds.flatMap((walletId) =>
        cashWalletIds.has(walletId)
          ? [activeSettlementWallet.id, legacyUsdWallet.id]
          : [walletId],
      ),
    ),
  )
}

export const cashWalletHistoryWalletIdsForPresentation = ({
  walletIds,
  presentation,
}: {
  walletIds?: WalletId[]
  presentation: CashWalletPresentationResult
}): WalletId[] => {
  const selectedWalletIds = walletIds ?? presentation.wallets.map((wallet) => wallet.id)

  return cashWalletHistoryWalletIds({ selectedWalletIds, presentation })
}

export const cashWalletHistoryWalletsForPresentation = ({
  wallets,
  presentation,
}: {
  wallets: Wallet[]
  presentation: CashWalletPresentationResult
}): Wallet[] => {
  const historyWalletIds = cashWalletHistoryWalletIds({
    selectedWalletIds: wallets.map((wallet) => wallet.id),
    presentation,
  })

  const walletById = new Map(
    [
      ...presentation.wallets,
      presentation.legacyUsdWallet,
      presentation.activeSettlementWallet,
      ...wallets,
    ]
      .filter((wallet): wallet is Wallet => Boolean(wallet))
      .map((wallet) => [wallet.id, wallet]),
  )

  return historyWalletIds
    .map((walletId) => walletById.get(walletId))
    .filter((wallet): wallet is Wallet => Boolean(wallet))
}
