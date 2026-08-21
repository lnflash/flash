import type { FygaroTopupAllowanceFailure } from "@app/fygaro/topup-allowance"
import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

import IError from "../../../shared/types/abstract/error"

const FygaroTopupAllowance = GT.Object({
  name: "FygaroTopupAllowance",
  description:
    "How much of today's card top-up allowance this account has left. Does not " +
    "authorise anything, so it is safe to call while the customer is still choosing " +
    "an amount. Render all of them: `remaining` is the cap less BOTH `spent` and " +
    "`held`, so without those two the gap cannot be explained. Floored at zero, so it " +
    "can be LARGER than `limit - spent - held` when the cap has been exceeded — via a " +
    "hand-credit, or via spend recorded before a limit change. The largest amount " +
    "that would actually go through is `min(remaining, singlePaymentLimit)`, and " +
    "anything below `minimum` is refused.",
  fields: () => ({
    limit: {
      type: GT.NonNull(CentAmount),
      description: "The account level's rolling 24-hour cap.",
    },
    spent: {
      type: GT.NonNull(CentAmount),
      description:
        "Gross charged in the trailing 24 hours. Payments we captured but did not " +
        "credit are excluded — they delivered nothing, so they do not spend the allowance.",
    },
    held: {
      type: GT.NonNull(CentAmount),
      description:
        "Card top-up links this account has open but has not paid. NOT spent — nothing " +
        "has been charged — but not available either, because paying one would charge " +
        "it. The common case is a customer who minted a link and closed the page, so " +
        "this is usually the whole difference between `limit - spent` and `remaining`.",
    },
    remaining: {
      type: GT.NonNull(CentAmount),
      description:
        "What would still be accepted right now AGAINST THE DAILY CAP: the cap less " +
        "BOTH `spent` and `held`. Unpaid checkout links are already subtracted, exactly " +
        "as the pre-charge check subtracts them, so this is what a new top-up is " +
        "measured against — not `limit - spent`. Never negative. NOT the largest " +
        "payable amount on its own: `singlePaymentLimit` is a separate ceiling and is " +
        "deliberately not folded in here, or this number would stop meaning 'daily " +
        "headroom' and `resetsAt` would stop describing it.",
    },
    singlePaymentLimit: {
      type: GT.NonNull(CentAmount),
      description:
        "The most that can be charged in ONE top-up, whatever the daily headroom. A " +
        "separate gate from the cap, so an account with $500 remaining and a $200 " +
        "single-payment limit can only pay $200 at a time — offering the $500 gets the " +
        "charge refused. Take `min(remaining, singlePaymentLimit)` as the maximum.",
    },
    minimum: {
      type: GT.NonNull(CentAmount),
      description:
        "The smallest top-up that will be accepted. Enforced before the charge, so a " +
        "client that does not render it can only discover it by being refused.",
    },
    resetsAt: {
      type: Timestamp,
      description:
        "When the oldest counted PAYMENT ages out and the allowance it spent returns. " +
        "Covers settled spend only — a hold is not a payment and never moves this. " +
        "Null when no payment is counted, even if `held` is non-zero; see `holdsExpireAt`.",
    },
    holdsExpireAt: {
      type: Timestamp,
      description:
        "When the SOONEST unpaid checkout link expires and its hold on the allowance " +
        "lifts by itself. Null when `held` is zero. This is the answer to 'why is " +
        "$65 left when I have spent nothing, and when do I get the rest back?'.",
    },
  }),
})

/**
 * The INTERNAL value behind each enum member — what a resolver must actually
 * return for GraphQL to serialize the member's name onto the wire.
 *
 * Declared here, next to the enum, because those strings live in TWO files:
 * these `value:` entries and the resolver's app-reason -> wire map. Nothing
 * linked them, and nothing could catch a divergence either — every test drives
 * `query.resolve(...)` directly, so GraphQL's own enum serialization never ran
 * in the suite at all. Renaming one `value:` would ship a field that throws
 * `Enum "FygaroTopupAllowanceUnavailableReason" cannot represent value: ...`
 * for every customer on the top-up screen, with a fully green build.
 *
 * As the declared type of both sides, a rename on either is now a compile
 * error. (`fygaro-topup-allowance.spec.ts` — the suite for THIS field, next to
 * the resolver's — also serializes every member through the real enum, so a
 * value that no member carries fails at runtime too. `fygaro-topup-status.spec.ts`
 * does the same for `FygaroTopupState`; neither covers the other's enum.)
 *
 * `rate-limited` is the one member with no `FygaroTopupAllowanceFailure` behind
 * it: the query refuses at the limiter, before the app layer is ever called, so
 * it is a refusal this edge owns rather than one it relays.
 */
export type FygaroTopupAllowanceUnavailableReasonValue =
  | FygaroTopupAllowanceFailure
  | "rate-limited"

const UNAVAILABLE_REASON_ENUM_VALUES: Record<
  string,
  { value: FygaroTopupAllowanceUnavailableReasonValue; description: string }
> = {
  CHECKOUT_DISABLED: {
    value: "checkout-disabled",
    description:
      "PERMANENT until an operator acts: card top-ups are switched off. Every " +
      "fygaroCheckoutCreate is refused in this state, so hide the card top-up " +
      "option rather than polling.",
  },
  LEVEL_NOT_ELIGIBLE: {
    value: "no-daily-limit-for-level",
    description:
      "PERMANENT until the account is upgraded: this account level has no card " +
      "top-up allowance at all. Hide the option and point at verification; retrying " +
      "changes nothing.",
  },
  SETTINGS_UNAVAILABLE: {
    value: "settings-unavailable",
    description:
      "TRANSIENT: the operator settings could not be read. Retry — nothing about " +
      "the account has changed.",
  },
  HISTORY_UNAVAILABLE: {
    value: "history-unavailable",
    description:
      "TRANSIENT: the trailing-24h top-up history could not be read. We refuse to " +
      "guess rather than show a full allowance we would then refuse to honour.",
  },
  RESERVATIONS_UNAVAILABLE: {
    value: "reservations-unavailable",
    description:
      "TRANSIENT: this account's open checkout links could not be read, so the " +
      "allowance cannot be known. Unknown holds are not zero holds.",
  },
  RATE_LIMITED: {
    value: "rate-limited",
    description:
      "TRANSIENT: too many allowance checks from this account too quickly. Back off " +
      "and reuse the last answer; nothing here is authorised, so no charge was lost.",
  },
}

/**
 * Why no allowance could be reported.
 *
 * The point of naming these is the difference between PERMANENT and TRANSIENT.
 * Two of them are permanent for this account right now — card top-ups are off,
 * or the level has no cap at all — and a client that cannot tell them apart
 * from an ERPNext blip renders the card top-up option anyway and has
 * `fygaroCheckoutCreate` refuse every single attempt. That is the
 * invite-then-refuse loop the allowance query exists to end, rebuilt on the
 * query added to end it.
 */
export const FygaroTopupAllowanceUnavailableReasonEnum = GT.Enum({
  name: "FygaroTopupAllowanceUnavailableReason",
  values: UNAVAILABLE_REASON_ENUM_VALUES,
})

/**
 * COMPATIBILITY SHIM for flash-mobile v0.6.7. Delete once that build has aged
 * out of the stores.
 *
 * v0.6.7 queries the payload as if it WERE the allowance:
 *
 *     fygaroTopupAllowance { limit held remaining holdsExpireAt }
 *
 * Those are fields of `FygaroTopupAllowance`, not of this payload, so the
 * server answers 400 GRAPHQL_VALIDATION_FAILED — and the app's global Apollo
 * handler turns any 4xx into a toast reading "StatusCode: 400 / Error code:
 * undefined" on the card top-up amount screen, every time it is opened. The
 * app shipped that way because codegen ran against a checked-in
 * `public-schema.graphql` that still described the pre-payload shape: the
 * generator validated happily against a schema the server had already moved
 * past.
 *
 * Aliasing the four fields here fixes every INSTALLED v0.6.7 without a store
 * release, which is the whole point — those users cannot be reached any other
 * way.
 *
 * `limit`/`held`/`remaining` are NON-NULL on purpose, and that is the subtle
 * part. When the allowance is unavailable (ERPNext unreadable, rate limited,
 * checkout disabled) `allowance` is null and these resolve to null, which is a
 * non-null violation. GraphQL propagates that up and nulls `data`, so the app
 * sees no allowance and falls back to rendering the flat per-level cap — which
 * is EXACTLY what it does today when the whole query 400s, and exactly what
 * the pre-payload schema did by returning a null allowance.
 *
 * Making them nullable instead would be worse, not safer: the app builds its
 * allowance object from any truthy payload (`use-card-topup-allowance.ts`), so
 * nulls would render as a zeroed allowance and tell the customer they have
 * nothing left to spend — a false refusal in place of a graceful fallback.
 *
 * The error that propagation produces is a GRAPHQL error on a 200, not a
 * network error. The app logs those and never toasts them (`client.tsx`:
 * "only network error are managed globally"), so the shim is silent in exactly
 * the case it needs to be.
 *
 * NEVER select these fields alongside `allowance`/`unavailableReason` in the
 * same document. When the allowance is unavailable, the non-null violation on
 * a flat field nulls the ENTIRE payload — `unavailableReason` included — and
 * that field's whole purpose is separating "hide the option" from "retry".
 * A transitional query that selects both shapes is precisely the likeliest
 * next query someone writes while migrating off these, and it silently
 * reinstates the invite-then-refuse loop the payload type exists to end.
 * v0.6.8+ must query ONLY the payload shape; these four are for the frozen
 * v0.6.7 document and nothing else. Pinned by the mixed-selection test in
 * fygaro-allowance-legacy-fields.spec.ts.
 */
type AllowancePayloadSource = {
  allowance?: {
    limit?: number
    held?: number
    remaining?: number
    // At runtime this is what the root resolver passes through from the app
    // layer: a `Date` when something is held, `undefined` when nothing is
    // (src/app/fygaro/topup-allowance.ts `holdsExpireAt?: Date`). `number` is
    // kept in the union because `Timestamp.serialize` accepts already-Unix
    // values too — but do NOT compare this field numerically: a Date coerces
    // via `valueOf` to MILLISECONDS, off by 1000x from Unix seconds.
    holdsExpireAt?: Date | number | null
  } | null
}

const LEGACY_UNWRAPPED_FIELDS = {
  limit: {
    type: GT.NonNull(CentAmount),
    deprecationReason: "Use `allowance.limit`. Present only for flash-mobile v0.6.7.",
    resolve: (source: AllowancePayloadSource) => source.allowance?.limit,
  },
  held: {
    type: GT.NonNull(CentAmount),
    deprecationReason: "Use `allowance.held`. Present only for flash-mobile v0.6.7.",
    resolve: (source: AllowancePayloadSource) => source.allowance?.held,
  },
  remaining: {
    type: GT.NonNull(CentAmount),
    deprecationReason: "Use `allowance.remaining`. Present only for flash-mobile v0.6.7.",
    resolve: (source: AllowancePayloadSource) => source.allowance?.remaining,
  },
  // Nullable in the inner type and nullable here: it is legitimately absent
  // when nothing is held, and v0.6.7 already guards it
  // (`raw.holdsExpireAt ? new Date(...) : undefined`). Making it non-null would
  // null the whole payload for every account with no open checkout — the
  // common case — and hide a perfectly good allowance behind the flat cap.
  holdsExpireAt: {
    type: Timestamp,
    deprecationReason:
      "Use `allowance.holdsExpireAt`. Present only for flash-mobile v0.6.7.",
    resolve: (source: AllowancePayloadSource) => source.allowance?.holdsExpireAt ?? null,
  },
}

export const FygaroTopupAllowancePayload = GT.Object({
  name: "FygaroTopupAllowancePayload",
  description:
    "The allowance, or why there isn't one. Exactly one of the two fields is ever " +
    "set. `unavailableReason` exists so the client can tell a state that will never " +
    "resolve on its own (hide the card top-up option) from a momentary read failure " +
    "(show the flat limit, retry) — collapsing both into a missing allowance is what " +
    "invites a top-up the pre-charge check then refuses.",
  fields: () => ({
    // Every other `*Payload` in this schema carries `errors`, including the
    // four that queries (not mutations) already return. Mobile codegen and the
    // shared "did this payload error" helpers key off that field, so a payload
    // without it silently opts out of the one convention the suffix promises.
    // Always an empty list here — this field reports a refusal as a NAMED
    // `unavailableReason` rather than an error, on purpose: it is decoration on
    // a screen the customer is still filling in, and a red banner over an
    // ERPNext blip would be worse than simply not showing the number.
    errors: {
      type: GT.NonNullList(IError),
      description:
        "Always empty. Refusals are reported as `unavailableReason`, not as errors — " +
        "the field is decoration on a screen the customer is still filling in, so a " +
        "read failure must not surface as one. Present for consistency with every " +
        "other payload type.",
    },
    allowance: {
      type: FygaroTopupAllowance,
      description: "Null whenever `unavailableReason` is set, and only then.",
    },
    unavailableReason: {
      type: FygaroTopupAllowanceUnavailableReasonEnum,
      description: "Null whenever `allowance` is present, and only then.",
    },
    ...LEGACY_UNWRAPPED_FIELDS,
  }),
})

export default FygaroTopupAllowance
