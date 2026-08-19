import {
  getFygaroTopupAllowance,
  type FygaroTopupAllowanceFailure,
} from "@app/fygaro/topup-allowance"
import { RateLimitConfig } from "@domain/rate-limit"
import { GT } from "@graphql/index"
import { FygaroTopupAllowancePayload } from "@graphql/public/types/object/fygaro-topup-allowance"
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
 */
const UNAVAILABLE_REASON: Record<FygaroTopupAllowanceFailure, string> = {
  "checkout-disabled": "checkout-disabled",
  "no-daily-limit-for-level": "no-daily-limit-for-level",
  "settings-unavailable": "settings-unavailable",
  "history-unavailable": "history-unavailable",
  "reservations-unavailable": "reservations-unavailable",
}

const FygaroTopupAllowanceQuery = GT.Field({
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
    if (limitOk instanceof Error) {
      // No allowance, but a NAMED one — a caller spending its budget on a
      // decorative number gets no number, and gets told to back off rather than
      // being left to guess whether card top-ups are off entirely. And when the
      // limiter STORE itself is down, refusing is still right: the allowance
      // read below fails closed on that same Redis anyway
      // (`reservations-unavailable`), so refusing here costs nothing and keeps
      // an outage from turning into unbounded ERPNext load.
      baseLogger.info(
        { accountId: domainAccount.id, error: limitOk.name },
        "Fygaro allowance query not answered: rate limiter refused or unavailable",
      )
      return { allowance: null, unavailableReason: "rate-limited" }
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
      return { allowance: null, unavailableReason: UNAVAILABLE_REASON[result.reason] }
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
