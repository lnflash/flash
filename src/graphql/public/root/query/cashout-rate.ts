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
        "Flash cashout service fee in basis points for the calling account, deducted from the USD amount before conversion. Already net of any Fee Discount the account is whitelisted for, and rounded to the nearest whole basis point — the offer may charge up to 1 bip more or less when the discount is a fraction of a percent.",
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
    // prevent. Fail-open (0 on any read problem) is inherited from
    // getFlashFeeDiscountPercent: the preview degrades to the standard fee, it
    // never breaks.
    //
    // Exactness caveat, deliberately documented rather than hidden: this is the
    // same "kept basis points" arithmetic CashoutManager uses, but the field is
    // an Int, so the discounted rate is rounded to a whole basis point HERE
    // while the offer keeps full precision and rounds once at the end, on money
    // (userPayment.multiplyBips(fee).multiplyBips(keptBips)). Whenever
    // `fee * keptBips / 10000` is not an integer the two differ by up to 1 bip.
    // With the configured 200-bip fee that is any discount_percent that is not a
    // multiple of 0.5: e.g. 33.4% -> keptBips 6660 -> this quotes
    // round(133.2) = 133 bips, while a $500 cashout is charged 1000¢ * 6660/10000
    // = 666¢, i.e. $6.66 against a $6.65 preview. Whole/half-percent discounts —
    // every discount ops has actually configured — are exact. The SDL
    // description states the tolerance; cashout-rate.spec.ts pins it.
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
