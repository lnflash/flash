import {
  getFygaroTopupAllowance,
  type FygaroTopupAllowanceFailure,
} from "@app/fygaro/topup-allowance"
import { RateLimitConfig } from "@domain/rate-limit"
import { FygaroTopupAllowanceRateLimiterExceededError } from "@domain/rate-limit/errors"
import { GT } from "@graphql/index"
import {
  FygaroTopupAllowancePayload,
  type FygaroTopupAllowanceUnavailableReasonValue,
} from "@graphql/public/types/object/fygaro-topup-allowance"
import { baseLogger } from "@services/logger"
import { consumeLimiter } from "@services/rate-limit"

/**
 * App-layer reason -> the wire enum's internal value.
 *
 * An exhaustive `Record`, not a lookup with a fallback, for the same reason
 * `fygaroTopupStatus` builds its wording that way: a fallback silently absorbs
 * any reason added later, so a new PERMANENT refusal would ship telling the
 * client to retry forever. As a Record over `FygaroTopupAllowanceFailure`, a
 * new member of that union is a compile error here until someone decides what
 * the client should be told.
 *
 * The VALUES are typed too — `FygaroTopupAllowanceUnavailableReasonValue`, the
 * union declared beside the enum itself. As plain `string` these six literals
 * were duplicated across two files with nothing linking them and no test that
 * could catch a divergence (every test drives `resolve()` directly, so the
 * enum's own serialization never ran). Renaming one `value:` over there would
 * ship a field that throws `Enum "FygaroTopupAllowanceUnavailableReason" cannot
 * represent value: ...` for every customer on the top-up screen, green build
 * and all. Now a rename on either side fails to compile.
 */
const UNAVAILABLE_REASON: Record<
  FygaroTopupAllowanceFailure,
  FygaroTopupAllowanceUnavailableReasonValue
> = {
  "checkout-disabled": "checkout-disabled",
  "no-daily-limit-for-level": "no-daily-limit-for-level",
  "settings-unavailable": "settings-unavailable",
  "history-unavailable": "history-unavailable",
  "reservations-unavailable": "reservations-unavailable",
}

// Same union, so the one reason with no app-layer failure behind it — the
// limiter refusing before the app layer is called — cannot drift either.
const RATE_LIMITED: FygaroTopupAllowanceUnavailableReasonValue = "rate-limited"

const FygaroTopupAllowanceQuery = GT.Field({
  // Same budget as `fygaroCheckoutCreate`, and for the same reason: both run
  // the trailing-24h ERPNext list query, and root fields resolve in PARALLEL.
  // Unscored, `simpleEstimator({ defaultComplexity: 1 })` lets one document
  // alias this field 25 times under the 200 ceiling and fire 25 concurrent
  // `sumFygaroTopupGrossCentsSince` reads — the exact read whose failure
  // refuses card top-ups for every user. The 30/min per-account limiter is no
  // answer to that: it consumes once per RESOLVE, so it only refuses the NEXT
  // request, after the burst has already landed. At 120 against a 200 ceiling
  // only one allowance read fits in a document, which is all a client that is
  // rendering one number ever needs.
  extensions: { complexity: 120 },
  type: GT.NonNull(FygaroTopupAllowancePayload),
  description:
    "How much card top-up allowance this account has left today. When the allowance " +
    "cannot be established, `unavailableReason` says why: hide the card top-up option " +
    "for the reasons that will not resolve on their own (CHECKOUT_DISABLED, " +
    "LEVEL_NOT_ELIGIBLE), and for the transient ones show the flat limit and let the " +
    "pre-charge check decide, rather than inventing a number.",
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    // Per-account, BEFORE the app call. Every call runs the trailing-24h
    // ERPNext list query — the same read whose failure refuses card top-ups for
    // every user — and this field is CHEAPER to abuse than fygaroCheckoutCreate
    // next door: no amount argument, so none of the deterministic gates can
    // short-circuit it. The field is blocked for API keys, so every caller is a
    // Kratos session, and the API-key limiter passes those through untouched;
    // without this there is no request-rate limit on the path at all.
    const limitOk = await consumeLimiter({
      rateLimitConfig: RateLimitConfig.fygaroTopupAllowance,
      keyToConsume: domainAccount.id,
    })
    if (limitOk instanceof FygaroTopupAllowanceRateLimiterExceededError) {
      // The caller really is over the limit. A NAMED refusal — a client
      // spending its budget on a decorative number gets no number, and gets
      // told to back off rather than being left to guess whether card top-ups
      // are off entirely.
      baseLogger.info(
        { accountId: domainAccount.id },
        "Fygaro allowance query not answered: rate limit exceeded",
      )
      return { errors: [], allowance: null, unavailableReason: RATE_LIMITED }
    }
    if (limitOk instanceof Error) {
      // The limiter STORE is down, not the caller misbehaving — `consume`
      // returns UnknownRateLimitServiceError for a store fault and
      // RateLimiterExceededError only for a real refusal, precisely so the two
      // are not conflated. Reporting a store fault as RATE_LIMITED told every
      // customer on the top-up screen "too many allowance checks from this
      // account too quickly. Back off and reuse the last answer" during a Redis
      // outage, which is a claim about their behaviour that is simply false.
      //
      // RESERVATIONS_UNAVAILABLE is what the app layer would have said, and it
      // is the honest answer: the limiter and the reservation index are the
      // SAME ioredis client (`@services/rate-limit` and
      // `readOutstandingReservations` both take `redis` from
      // `@services/redis`), so a store fault here means the hold read below
      // fails closed too. Answering it directly rather than falling through
      // like `fygaroCheckoutCreate` does keeps a Redis outage from turning into
      // unbounded ERPNext load on the very read whose failure refuses card
      // top-ups for everyone — this query authorises nothing, so there is no
      // gate one step later that needs entering to produce the right message.
      // Same reason, same wording as the sibling mutation ends up with; only
      // the mechanism differs.
      baseLogger.warn(
        { accountId: domainAccount.id, error: limitOk.name },
        "Fygaro allowance rate limiter unavailable; reporting the underlying store outage",
      )
      return {
        errors: [],
        allowance: null,
        unavailableReason: UNAVAILABLE_REASON["reservations-unavailable"],
      }
    }

    const result = await getFygaroTopupAllowance({
      accountId: domainAccount.id,
      level: domainAccount.level,
    })
    // A named refusal rather than an error: this is decoration on a screen the
    // customer is still filling in, and a red banner over an ERPNext blip would
    // be worse than simply not showing the number. Nothing is authorised here —
    // the real gate still runs before any charge — but the client needs to know
    // whether a top-up is impossible right now (hide the option) or the number
    // is merely unknown (show the flat limit and let the charge path decide).
    if (!result.available) {
      return {
        errors: [],
        allowance: null,
        unavailableReason: UNAVAILABLE_REASON[result.reason],
      }
    }

    // `remaining` is deliberately NOT `limit - spent`: it also has this
    // account's unpaid checkout links subtracted, exactly as the pre-charge gate
    // subtracts them, so the two surfaces answer the same question with the same
    // number. `spent` keeps its own meaning — gross actually charged — because a
    // hold is not a charge and calling it one would be its own false claim.
    //
    // Which is precisely why `held` and `holdsExpireAt` are reported too. The
    // canonical case is a customer who minted a $60 link and closed the page:
    // nothing is charged, so `spent` is 0 and `resetsAt` (settled spend only) is
    // null, yet $60 of a $125 cap is gone. Without these two fields the client
    // can neither name the missing money nor say when it comes back.
    //
    // `singlePaymentLimit` and `minimum` are the gate's OTHER two bounds. They
    // are not folded into `remaining` — that number means daily headroom, and
    // `resetsAt` describes it — but without them a client offering `remaining`
    // as the maximum invites a charge the single-payment ceiling then refuses.
    const {
      limitCents,
      spentCents,
      heldCents,
      remainingCents,
      singlePaymentLimitCents,
      minimumCents,
      resetsAt,
      holdsExpireAt,
    } = result.allowance
    return {
      errors: [],
      allowance: {
        limit: limitCents,
        spent: spentCents,
        held: heldCents,
        remaining: remainingCents,
        singlePaymentLimit: singlePaymentLimitCents,
        minimum: minimumCents,
        resetsAt,
        holdsExpireAt,
      },
      unavailableReason: null,
    }
  },
})

export default FygaroTopupAllowanceQuery
