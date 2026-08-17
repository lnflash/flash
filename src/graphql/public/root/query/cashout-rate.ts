import { Cashout } from "@config"
import { JMDAmount } from "@domain/shared"
import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import JMDCentsScalar from "@graphql/shared/types/scalar/jmd-cent-amount"
import ErpNext from "@services/frappe/ErpNext"
import { getFlashFeeDiscountPercent } from "@services/frappe/fee-discounts"

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
        "Flash cashout service fee in basis points for the calling account, deducted from the USD amount before conversion. Already net of any Fee Discount the account is whitelisted for, so it matches the fee the offer will charge.",
      resolve: (source: CashoutRateSource) => source.feeBasisPoints,
    },
  }),
})

const CashoutRateQuery = GT.Field({
  type: GT.NonNull(CashoutRateType),
  resolve: async (
    _: unknown,
    __: Record<string, never>,
    { domainAccount }: GraphQLPublicContextAuth,
  ) => {
    const exchangeRate = await ErpNext.getCashoutExchangeRate()
    if (exchangeRate instanceof Error) {
      throw mapAndParseErrorForGqlResponse(exchangeRate)
    }

    // Quote the fee this caller will actually be charged. CashoutManager
    // applies the same Fee Discount when it builds the offer, so a whitelisted
    // user seeing the undiscounted config fee here would watch the preview
    // disagree with the offer — the exact mismatch this query exists to
    // prevent. Same "kept basis points" arithmetic as CashoutManager so the
    // two agree to 0.01% of discount precision. Fail-open (0 on any read
    // problem) is inherited from getFlashFeeDiscountPercent: the preview
    // degrades to the standard fee, it never breaks.
    const discountPercent = await getFlashFeeDiscountPercent({
      username: domainAccount?.username,
      flow: "cashout",
    })
    const keptBips = 10000 - Math.round(discountPercent * 100)
    const feeBasisPoints = Math.round(
      (Number(Cashout.OfferConfig.fee) * keptBips) / 10000,
    )

    return {
      exchangeRate,
      feeBasisPoints,
    }
  },
})

export default CashoutRateQuery
