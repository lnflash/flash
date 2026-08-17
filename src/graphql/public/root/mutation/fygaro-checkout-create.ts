import {
  authorizeFygaroTopup,
  type AuthorizeTopupResult,
} from "@app/fygaro/authorize-topup"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import FygaroCheckout from "@graphql/public/types/object/fygaro-checkout"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import IError from "@graphql/shared/types/abstract/error"
import {
  FygaroAboveSinglePaymentLimitError,
  FygaroAllowanceUnavailableError,
  FygaroBelowMinimumError,
  FygaroCheckoutDisabledError,
  FygaroDailyAllowanceExceededError,
} from "@services/fygaro/errors"

const FygaroCheckoutCreatePayload = GT.Object({
  name: "FygaroCheckoutCreatePayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    checkout: { type: FygaroCheckout },
    remainingAllowance: {
      type: CentAmount,
      description:
        "What is left of today's top-up allowance after this request. Present on refusal " +
        "too, so the client can say how much would be accepted instead of only saying no. " +
        "Null when the allowance itself could not be established.",
    },
  }),
})

const FygaroCheckoutCreateInput = GT.Input({
  name: "FygaroCheckoutCreateInput",
  fields: () => ({
    amount: { type: GT.NonNull(CentAmount) },
  }),
})

const centsToDollars = (cents: number) => (cents / 100).toFixed(2)

/**
 * Turn a refusal into the error the client shows the customer.
 *
 * Where we know the actual number, it goes in the message: "you have $45 left
 * today" is actionable, "limit exceeded" is not — and the customer has not been
 * charged at this point, so they can still act on it.
 */
const failureError = (result: AuthorizeTopupResult & { authorized: false }): Error => {
  const { reason, limitCents, minimumCents, remainingAllowanceCents } = result
  switch (reason) {
    case "below-minimum":
      return new FygaroBelowMinimumError(
        minimumCents === undefined
          ? "Amount is below the minimum top-up"
          : `The minimum top-up is $${centsToDollars(minimumCents)}`,
      )
    case "above-single-payment-limit":
      return new FygaroAboveSinglePaymentLimitError(
        limitCents === undefined
          ? "Amount is above the single top-up limit"
          : `The most you can top up in one payment is $${centsToDollars(limitCents)}`,
      )
    case "exceeds-daily-allowance":
      return new FygaroDailyAllowanceExceededError(
        remainingAllowanceCents === undefined
          ? "Amount is above your remaining daily top-up allowance"
          : `You have $${centsToDollars(remainingAllowanceCents)} left of today's top-up limit`,
      )
    case "settings-unavailable":
    case "history-unavailable":
    case "no-daily-limit-for-level":
      return new FygaroAllowanceUnavailableError()
    case "checkout-disabled":
      return new FygaroCheckoutDisabledError()
  }
}

const fygaroCheckoutCreate = GT.Field<
  null,
  GraphQLPublicContextAuth,
  { input: { amount: number | InputValidationError } }
>({
  extensions: { complexity: 120 },
  type: GT.NonNull(FygaroCheckoutCreatePayload),
  args: {
    input: { type: GT.NonNull(FygaroCheckoutCreateInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { amount } = args.input
    if (amount instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(amount)] }
    }

    // custom_reference is how the webhook attributes the payment to an account.
    // Without a username there is nothing to put in it, so the payment would
    // arrive unattributable — refuse before the customer is charged.
    if (!domainAccount.username) {
      return {
        errors: [
          mapAndParseErrorForGqlResponse(
            new FygaroCheckoutDisabledError("Set a username before topping up by card"),
          ),
        ],
      }
    }

    const result = await authorizeFygaroTopup({
      accountId: domainAccount.id,
      username: domainAccount.username,
      level: domainAccount.level,
      amountCents: amount,
    })

    if (!result.authorized) {
      return {
        errors: [mapAndParseErrorForGqlResponse(failureError(result))],
        remainingAllowance: result.remainingAllowanceCents,
      }
    }

    return {
      errors: [],
      checkout: {
        url: result.checkout.url,
        expiresAt: result.checkout.expiresAt,
        amount: amount,
      },
      remainingAllowance: result.remainingAllowanceCents,
    }
  },
})

export default fygaroCheckoutCreate
