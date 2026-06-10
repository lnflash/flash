import {
  MoneyAmount,
  USDTAmount,
  WalletCurrency,
  toMoneyAmountFromJSON,
} from "@domain/shared"

import { CashoutDetails } from "../types"

/**
 * Custom SerDe for CashoutDetails
 */
export const OffersSerde = {
  serialize: (data: CashoutDetails): string => {
    return JSON.stringify(data, (_, value) => {
      if (value instanceof MoneyAmount || value instanceof USDTAmount)
        return value.toJson()
      else if (typeof value === "bigint") return value.toString()
      else return value
    })
  },

  deserialize: (json: string): CashoutDetails => {
    return JSON.parse(json, (key: string, value: unknown) => {
      if (
        ["amount", "servicefee", "exchangerate"].includes(key.toLowerCase()) &&
        Array.isArray(value)
      ) {
        if (value[1] === WalletCurrency.Usdt)
          return USDTAmount.smallestUnits(value[0] as string)
        return toMoneyAmountFromJSON(value as [string, string])
      }
      return value
    })
  },
}
