import { getFygaroTopupAllowance } from "@app/fygaro/topup-allowance"
import { RateLimitConfig } from "@domain/rate-limit"
import { GT } from "@graphql/index"
import FygaroTopupAllowance from "@graphql/public/types/object/fygaro-topup-allowance"
import { baseLogger } from "@services/logger"
import { consumeLimiter } from "@services/rate-limit"

const FygaroTopupAllowanceQuery = GT.Field({
  type: FygaroTopupAllowance,
  description:
    "How much card top-up allowance this account has left today. Null when the " +
    "allowance cannot currently be established — show the flat limit and let the " +
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
      // Null, not an error — the same answer this field already gives for
      // "cannot establish". A caller spending its budget on a decorative number
      // gets no number; a client that behaves gets one. And when the limiter
      // STORE itself is down, null is still right: the allowance read below
      // fails closed on that same Redis anyway (`reservations-unavailable`), so
      // refusing here costs nothing and keeps an outage from turning into
      // unbounded ERPNext load.
      baseLogger.info(
        { accountId: domainAccount.id, error: limitOk.name },
        "Fygaro allowance query not answered: rate limiter refused or unavailable",
      )
      return null
    }

    const result = await getFygaroTopupAllowance({
      accountId: domainAccount.id,
      level: domainAccount.level,
    })
    // Null rather than an error: this is decoration on a screen the customer is
    // still filling in, and a red banner over an ERPNext blip would be worse
    // than simply not showing the number. Nothing is authorised here — the
    // real gate still runs before any charge.
    if (!result.available) return null

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
    const { limitCents, spentCents, heldCents, remainingCents, resetsAt, holdsExpireAt } =
      result.allowance
    return {
      limit: limitCents,
      spent: spentCents,
      held: heldCents,
      remaining: remainingCents,
      resetsAt,
      holdsExpireAt,
    }
  },
})

export default FygaroTopupAllowanceQuery
