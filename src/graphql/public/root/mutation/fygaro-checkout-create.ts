import {
  authorizeFygaroTopup,
  type AuthorizeTopupResult,
} from "@app/fygaro/authorize-topup"
import { RateLimitConfig } from "@domain/rate-limit"
import { FygaroCheckoutCreateRateLimiterExceededError } from "@domain/rate-limit/errors"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import FygaroCheckout from "@graphql/public/types/object/fygaro-checkout"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import IError from "@graphql/shared/types/abstract/error"
import { baseLogger } from "@services/logger"
import { consumeLimiter } from "@services/rate-limit"
import {
  FygaroAboveSinglePaymentLimitError,
  FygaroAllowanceUnavailableError,
  FygaroBelowMinimumError,
  FygaroCheckoutAlreadyOpenError,
  FygaroCheckoutDisabledError,
  FygaroDailyAllowanceExceededError,
  FygaroLevelNotEligibleError,
} from "@services/fygaro/errors"

const FygaroCheckoutCreatePayload = GT.Object({
  name: "FygaroCheckoutCreatePayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    checkout: { type: FygaroCheckout },
    remainingAllowance: {
      type: CentAmount,
      description:
        "How much more could be authorised right now, after this request. Card top-up " +
        "links you have open but have not paid are ALREADY SUBTRACTED, so this is what " +
        "would be accepted this second — not a statement of what the account has spent " +
        "today. Present on refusal too, so the client can say how much would go through " +
        "instead of only saying no. Null when the allowance could not be established.",
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
 * Whole minutes until `at`, floor 1.
 *
 * Deliberately relative rather than a wall-clock "HH:MM": the server renders in
 * UTC and the customer is not in it, so a clock time here is a time they cannot
 * act on. "in 12 minutes" is correct in every timezone.
 */
const minutesUntil = (at: Date, nowMs: number = Date.now()): number =>
  Math.max(1, Math.ceil((at.getTime() - nowMs) / 60_000))

/**
 * Turn a refusal into the error the client shows the customer.
 *
 * Where we know the actual number, it goes in the message: "you have $45 left
 * today" is actionable, "limit exceeded" is not — and the customer has not been
 * charged at this point, so they can still act on it.
 */
const failureError = (result: AuthorizeTopupResult & { authorized: false }): Error => {
  const {
    reason,
    limitCents,
    minimumCents,
    remainingAllowanceCents,
    holdExpiresAt,
    holdAmountCents,
  } = result
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
    case "checkout-already-open":
      // The account has NOT spent this money — it is holding it in a link it
      // opened and did not pay. Saying "you have $0.00 left of today's limit"
      // to an account that has spent $0.00 today is simply false, and it points
      // the customer (and support) at the wrong thing entirely.
      return new FygaroCheckoutAlreadyOpenError(
        holdExpiresAt === undefined
          ? "You already have a card top-up link open. Finish that payment, or wait for it to expire, before starting another."
          : `You already have a${
              holdAmountCents === undefined ? "" : ` $${centsToDollars(holdAmountCents)}`
            } card top-up link open — it expires in ${minutesUntil(holdExpiresAt)} minute(s). Finish that payment, or wait for it to expire, before starting another.`,
      )
    case "non-positive-net":
      // Above the operator minimum, but the fixed processor + Flash fees eat
      // the whole thing. "Too small" is the honest thing to tell the customer;
      // it is not a limit and not an outage.
      return new FygaroBelowMinimumError(
        "That amount is too small to cover the payment fees",
      )
    case "no-daily-limit-for-level":
      // Deterministic and permanent until the account upgrades — NOT one of the
      // three transient failures below. Telling a level-0 account to try again
      // later would loop forever and send support after a phantom outage.
      return new FygaroLevelNotEligibleError()
    // The three transient stops. ERPNext settings, ERPNext history and the
    // Redis reservation index fail differently and alert differently, but the
    // customer-facing answer is identical: we could not measure your allowance,
    // try again. The distinction exists for the ALERT and the log, not here.
    case "settings-unavailable":
    case "history-unavailable":
    case "reservations-unavailable":
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
    // What CentAmount hands back for a negative/oversized/non-integer value is
    // an InputValidationError — an Apollo error, NOT an ApplicationError. Run
    // through mapAndParseErrorForGqlResponse it falls off the end of the switch
    // and throws `assertUnreachable`, turning a bad client amount into an
    // internal error. Same handling as every other scalar-validated mutation
    // (see ln-noamount-usd-invoice-payment-send).
    if (amount instanceof Error) {
      return { errors: [{ message: amount.message }] }
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

    // Per-account, BEFORE the authorisation runs. Every call that gets past the
    // cheap deterministic gates runs an ERPNext list query, and the two gates a
    // spam client would trip (`under-minimum`, `non-positive-net`) sit AFTER
    // the history gate — so `fygaroCheckoutCreate(amount: 1)` in a loop is
    // unbounded ERPNext load pointed at the exact read whose failure refuses
    // card top-ups for every user. Same treatment as invoiceCreate /
    // onChainAddressCreate / inviteCreate.
    const limitOk = await consumeLimiter({
      rateLimitConfig: RateLimitConfig.fygaroCheckoutCreate,
      keyToConsume: domainAccount.id,
    })
    if (limitOk instanceof FygaroCheckoutCreateRateLimiterExceededError) {
      return { errors: [mapAndParseErrorForGqlResponse(limitOk)] }
    }
    if (limitOk instanceof Error) {
      // The limiter STORE is down, not the caller misbehaving. Refusing here
      // would tell every customer they are rate limited on their first attempt
      // and would page nobody, because authorizeFygaroTopup — which fails
      // closed on its own Redis read and alerts as `reservations-unavailable`
      // — would never be entered. Fall through instead: the same outage stops
      // the authorisation one step later, with the honest message and the
      // page. This cannot open an abuse window, because no link can be minted
      // while the store the reservation index lives in is unreachable.
      baseLogger.warn(
        { accountId: domainAccount.id, error: limitOk.name },
        "Fygaro checkout rate limiter unavailable; deferring to the authorisation gate",
      )
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
