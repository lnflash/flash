import {
  MoneyAmount,
  USDTAmount,
  WalletCurrency,
  toMoneyAmountFromJSON,
} from "@domain/shared"

import { CashoutDetails } from "../types"

/**
 * Custom serializer/deserializer for CashoutDetails
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
      if (key === "expiresAt" && typeof value === "string") return new Date(value)

      if (
        ["amount", "servicefee", "exchangerate"].includes(key.toLowerCase()) &&
        Array.isArray(value)
      ) {
        const amount =
          value[1] === WalletCurrency.Usdt
            ? USDTAmount.smallestUnits(value[0] as string)
            : toMoneyAmountFromJSON(value as [string, string])
        if (amount instanceof Error) throw amount
        return amount
      }
      return value
    })
  },
}
