import { USDAmount } from "@domain/shared/MoneyAmount"

export type PayInvoiceArgs = {
  accountId: IbexAccountId,
  invoice: Bolt11,
  send?: USDAmount // must match currency of account
}

// Ibex supports fee estimation in different currencies
export type GetFeeEstimateArgs = {
  invoice: Bolt11,
  send?: USDAmount
}

export type IbexFeeEstimation = {
  fee: USDAmount,
  invoice: USDAmount,
}

export type IbexAccountDetails = {
    id: string | undefined;
    userId: string | undefined;
    name: string | undefined;
    balance: USDAmount | undefined;
}

export type IbexInvoiceArgs = { 
  accountId: IbexAccountId,
  amount?: USDAmount
  memo: string
  expiration?: Seconds 
};
