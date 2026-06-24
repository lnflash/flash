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
  id?: string
  currencyId: number
  network: string
  name?: string
}

export interface IbexCurrency {
  id: IbexCurrencyId
  name: string
  isFiat: boolean
  symbol: string
  accountEnabled: boolean
}

export interface CryptoReceiveInfo {
  id: string
  wallet_id: string
  option_id: string
  data: {
    address: string
  }
  currency: string
  network: string
  created_at: string
}

export interface CreateCryptoReceiveInfoRequest {
  name: string
  network: string
}

export interface CryptoSendRequirements {
  requirementsId: string
  type?: string
  currencyId?: number
  data: Record<string, unknown>
  [key: string]: unknown
}

export interface CreateCryptoSendInfoBodyParam {
  name: string
  requirementsId: string
  data: Record<string, unknown>
}

export interface CryptoSendInfo {
  id: string
  name: string
  currencyId?: number
  network?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

export interface CryptoSendBodyParam {
  accountId: string
  cryptoSendInfosId: string
  amount: number
}

export interface CryptoSendResponse {
  transaction?: {
    id?: string
    createdAt?: string
    settledAt?: string | null
    accountId?: string
    amount?: number
    networkFee?: number
    onChainSendFee?: number
    exchangeRateCurrencySats?: number
    currencyId?: number
    transactionTypeId?: string | number
    status?: string
    [key: string]: unknown
  }
  transactionHub?: {
    id?: string
    createdAt?: string
    settledAt?: string | null
    accountId?: string
    amount?: number
    networkFee?: number
    currencyId?: number
    transactionTypeId?: number
    txHash?: string
    transactionHash?: string
    hash?: string
    [key: string]: unknown
  }
  cryptoTransaction?: {
    id?: string
    network?: string
    address?: string
    amount?: number
    status?: string
    txHash?: string
    networkTxId?: string
    [key: string]: unknown
  }
  transactionId?: string
  txHash?: string
  transactionHash?: string
  networkTxId?: string
  status?: string
  amount?: number
  [key: string]: unknown
}
