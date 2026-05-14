import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"

export type UsdWalletAmount = USDAmount | USDTAmount

export type PayInvoiceArgs = {
  accountId: IbexAccountId
  invoice: Bolt11
  send?: UsdWalletAmount // must match currency of account
}

export type SendOnchainArgs = {
  accountId: IbexAccountId // source of funds
  address: OnChainAddress // destination
  amount: UsdWalletAmount
}

// Ibex supports fee estimation in different currencies
export type GetFeeEstimateArgs = {
  invoice: Bolt11
  send?: UsdWalletAmount
  currency?: WalletCurrency
}

export type IbexFeeEstimation<T extends UsdWalletAmount = USDAmount> = {
  fee: T
  invoice: T
}

export type IbexAccountDetails = {
  id: string | undefined
  userId: string | undefined
  name: string | undefined
  balance: USDAmount | USDTAmount | undefined
}

export type IbexInvoiceArgs = {
  accountId: IbexAccountId
  amount?: UsdWalletAmount
  memo: string
  expiration?: Seconds
}

export interface CryptoReceiveOption {
  id: string
  currency: string
  network: string
  name: string
}

export interface CryptoReceiveInfo {
  id: string
  wallet_id: string
  option_id: string
  address: string
  currency: string
  network: string
  created_at: string
}

export interface CreateCryptoReceiveInfoRequest {
  name: string
  network: string
}
