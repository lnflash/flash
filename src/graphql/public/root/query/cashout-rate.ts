import { Cashout } from "@config"
import { JMDAmount } from "@domain/shared"
import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import JMDCentsScalar from "@graphql/shared/types/scalar/jmd-cent-amount"
import ErpNext from "@services/frappe/ErpNext"

// The settlement rate the app shows BEFORE a cashout offer exists. This is the
// same source `CashoutManager.createOffer` locks into a JMD offer (ERPNext
// Currency Exchange, NCB for_buying side), so the entry-screen preview matches
// the offer and the ERPNext Cashout doc — unlike the realtimePrice display
// rate, which is a mid-market feed with no bank spread.
type CashoutRateSource = {
  exchangeRate: JMDAmount
  feeBasisPoints: number
}

const CashoutRateType = GT.Object({
  name: "CashoutRate",
  fields: () => ({
    exchangeRate: {
      type: GT.NonNull(JMDCentsScalar),
      description:
        "JMD cents per 1 USD at which a JMD cashout would settle right now — the same rate a cashout offer locks in.",
      resolve: (source: CashoutRateSource) => source.exchangeRate,
    },
    feeBasisPoints: {
      type: GT.NonNull(GT.Int),
      description:
        "Flash cashout service fee in basis points, deducted from the USD amount before conversion.",
      resolve: (source: CashoutRateSource) => source.feeBasisPoints,
    },
  }),
})

const CashoutRateQuery = GT.Field({
  type: GT.NonNull(CashoutRateType),
  resolve: async () => {
    const exchangeRate = await ErpNext.getCashoutExchangeRate()
    if (exchangeRate instanceof Error) {
      throw mapAndParseErrorForGqlResponse(exchangeRate)
    }
    return {
      exchangeRate,
      feeBasisPoints: Number(Cashout.OfferConfig.fee),
    }
  },
})

export default CashoutRateQuery
