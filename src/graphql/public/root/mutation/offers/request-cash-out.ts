import OffersManager from "@app/offers/OffersManager"
import { USDAmount } from "@domain/shared"
import { mapToGqlErrorList } from "@graphql/error-map"
import { GT } from "@graphql/index"
import CashoutOffer from "@graphql/public/types/object/cashout-offer"
import IError from "@graphql/shared/types/abstract/error"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import dedent from "dedent"

const USDCentsScalar = GT.Scalar({
    name: "USDCents",
    description: "Amount in USD cents",
    parseValue(value: unknown): USDAmount {
      let amt = value as number | string 
      const amount = USDAmount.cents(amt.toString())
      if (amount instanceof Error) {
          throw new Error(`Invalid USD amount: ${value}`)
      }
      return amount
    },
    serialize(value: unknown): number {
        if (value instanceof USDAmount) {
            return Number(value.asCents()) 
        }
        else throw new Error(`Failed to serialize USDAmount: ${value}`)
    }
})

const RequestCashoutInput = GT.Input({
  name: "RequestCashoutInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description: "ID for a USD wallet belonging to the current user.",
    },
    amount: {
      type: GT.NonNull(USDCentsScalar), 
      description: "Amount in USD cents." 
    },
  }),
})

const RequestCashoutResponse = GT.Object({
  name: "RequestCashoutResponse",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    offer: {
      type: CashoutOffer,
    },
  }),
})

const RequestCashoutMutation = GT.Field({
  description: dedent`Returns an offer from Flash for a user to withdraw from their USD wallet (denominated in cents).
  The user can review this offer and then execute the withdrawal by calling the initiateCashout mutation.`,
  args: {
    input: { type: GT.NonNull(RequestCashoutInput) },
  },
  type: GT.NonNull(RequestCashoutResponse),
  extensions: {
    complexity: 120,
  },
  resolve: async (_, args) => {
    const { walletId, amount } = args.input
    for (const input of [walletId, amount]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    const offer = await (OffersManager.createCashoutOffer(
      walletId,
      amount, 
    ))
    if (offer instanceof Error) return { errors: mapToGqlErrorList(offer) }

    return {
      errors: [],
      offer
    }
  },
})

export default RequestCashoutMutation