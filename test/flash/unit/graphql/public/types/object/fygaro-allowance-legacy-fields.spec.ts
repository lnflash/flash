import {
  graphql,
  validate,
  parse,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLNonNull,
} from "graphql"

import { FygaroTopupAllowancePayload } from "@graphql/public/types/object/fygaro-topup-allowance"

/**
 * The v0.6.7 document, verbatim.
 *
 * Copied from flash-mobile `app/hooks/use-card-topup-allowance.ts` at tag
 * ios/v0.6.7. It queries the PAYLOAD as if it were the allowance, which is the
 * whole bug: those are fields of `FygaroTopupAllowance`, and the server answers
 * 400 GRAPHQL_VALIDATION_FAILED without the compatibility shim. The app's global
 * Apollo handler turns any 4xx into a "StatusCode: 400" toast on the card
 * top-up amount screen.
 *
 * Held here as a literal rather than generated, because its whole value is
 * being a FROZEN copy of what a shipped build sends. Regenerating it from the
 * current schema would make it agree with us by construction and assert nothing.
 */
const V067_ALLOWANCE_QUERY = `
  query fygaroTopupAllowance {
    fygaroTopupAllowance {
      limit
      held
      remaining
      holdsExpireAt
    }
  }
`

/**
 * A one-field schema wrapping the REAL payload type, so the aliasing resolvers
 * actually run.
 *
 * Two things this deliberately is not. It is not `buildSchema` over the checked
 * -in SDL: that yields default resolvers which read `payload.limit` directly and
 * would pass whether or not the aliasing resolvers exist — the very thing under
 * test. And it is not the assembled `gqlMainSchema`: importing that drags in the
 * whole server, which constructs Redis and Mongo clients at import time and
 * hangs the runner.
 *
 * `GT.NonNull` on the field mirrors the real root, which is what makes a
 * non-null violation inside the payload propagate all the way to `data: null`.
 */
const publicSchema = () =>
  new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: {
        fygaroTopupAllowance: {
          type: new GraphQLNonNull(FygaroTopupAllowancePayload),
          resolve: (root: { fygaroTopupAllowance: unknown }) => root.fygaroTopupAllowance,
        },
      },
    }),
  })

describe("v0.6.7 allowance compatibility", () => {
  it("validates against the published schema", () => {
    // The regression that matters. Before the shim this produced
    // GRAPHQL_VALIDATION_FAILED, which is a 400 on the wire — an error toast on
    // a money screen for every already-installed v0.6.7, reachable by no
    // release we can ship to them.
    const errors = validate(publicSchema(), parse(V067_ALLOWANCE_QUERY))
    expect(errors).toHaveLength(0)
  })

  it("serves the allowance through the flat fields", async () => {
    const schema = publicSchema()
    const result = await graphql({
      schema,
      source: V067_ALLOWANCE_QUERY,
      rootValue: {
        fygaroTopupAllowance: {
          errors: [],
          unavailableReason: null,
          allowance: {
            limit: 12500,
            spent: 0,
            held: 6000,
            remaining: 6500,
            singlePaymentLimit: 49900,
            minimum: 1000,
            resetsAt: null,
            holdsExpireAt: 1787340000,
          },
        },
      },
    })

    expect(result.errors).toBeUndefined()
    expect(result.data?.fygaroTopupAllowance).toEqual({
      limit: 12500,
      held: 6000,
      remaining: 6500,
      holdsExpireAt: 1787340000,
    })
  })

  it("serves the common case — allowance present, nothing held, holdsExpireAt absent — with a null holdsExpireAt", async () => {
    // The most common production shape: the app layer's `holdsExpireAt?: Date`
    // is simply absent when nothing is held, and the root resolver passes that
    // `undefined` straight through. The shim's `?? null` must absorb it so the
    // nullable Timestamp serves an explicit null — never a propagated error,
    // which would null the whole payload and hide a perfectly good allowance
    // behind the flat cap.
    const result = await graphql({
      schema: publicSchema(),
      source: V067_ALLOWANCE_QUERY,
      rootValue: {
        fygaroTopupAllowance: {
          errors: [],
          unavailableReason: null,
          allowance: {
            limit: 12500,
            spent: 0,
            held: 0,
            remaining: 12500,
            singlePaymentLimit: 49900,
            minimum: 1000,
            // resetsAt and holdsExpireAt intentionally omitted (undefined), as
            // the app layer returns them when nothing is counted or held.
          },
        },
      },
    })

    expect(result.errors).toBeUndefined()
    expect(result.data?.fygaroTopupAllowance).toEqual({
      limit: 12500,
      held: 0,
      remaining: 12500,
      holdsExpireAt: null,
    })
  })

  it("serializes a Date holdsExpireAt — the actual runtime type — as Unix seconds", async () => {
    // The root resolver passes the app layer's `holdsExpireAt?: Date` through
    // untouched, so a Date (not a number) is what reaches the shim at runtime.
    // Timestamp.serialize must turn it into Unix SECONDS — a numeric coercion
    // via valueOf would be milliseconds, silently off by 1000x.
    const holdsExpireAt = new Date(1787340000 * 1000)
    const result = await graphql({
      schema: publicSchema(),
      source: V067_ALLOWANCE_QUERY,
      rootValue: {
        fygaroTopupAllowance: {
          errors: [],
          unavailableReason: null,
          allowance: {
            limit: 12500,
            spent: 0,
            held: 6000,
            remaining: 6500,
            singlePaymentLimit: 49900,
            minimum: 1000,
            resetsAt: null,
            holdsExpireAt,
          },
        },
      },
    })

    expect(result.errors).toBeUndefined()
    expect(result.data?.fygaroTopupAllowance).toEqual({
      limit: 12500,
      held: 6000,
      remaining: 6500,
      holdsExpireAt: 1787340000,
    })
  })

  it("nulls the payload when the allowance is unavailable, rather than zeroing it", async () => {
    // THE REASON limit/held/remaining ARE NON-NULL.
    //
    // v0.6.7 builds its allowance object from any truthy payload, so nullable
    // fields would hand it {limitCents: null, remainingCents: null} and the
    // screen would tell a customer they have nothing left to spend — a false
    // refusal. Non-null makes the violation propagate and null `data` instead,
    // which is precisely what the app already handles: no allowance, fall back
    // to the flat per-level cap.
    const result = await graphql({
      schema: publicSchema(),
      source: V067_ALLOWANCE_QUERY,
      rootValue: {
        fygaroTopupAllowance: {
          errors: [],
          allowance: null,
          unavailableReason: "HISTORY_UNAVAILABLE",
        },
      },
    })

    // Propagation does not stop at the payload: the root field is NonNull too,
    // so the whole of `data` goes null. That is the best possible outcome here —
    // the app reads `data?.fygaroTopupAllowance`, gets undefined, and takes the
    // flat-cap path it already has.
    expect(result.data).toBeNull()
    // A GraphQL error on a 200 — NOT a network error. The app logs these and
    // never toasts them ("only network error are managed globally",
    // flash-mobile app/graphql/client.tsx), so the fallback is silent.
    expect(result.errors?.length).toBeGreaterThan(0)
  })

  it("nulls the WHOLE payload — unavailableReason included — on a mixed selection", async () => {
    // THE TRAP the shim docblock warns about, pinned so it is a documented
    // property rather than a discovery. A transitional client that selects a
    // deprecated flat field ALONGSIDE the modern shape loses everything when
    // the allowance is unavailable: the non-null violation on `limit` nulls
    // the entire payload, `unavailableReason` with it. The client cannot tell
    // "checkout is disabled, hide the option" from an ERPNext blip — the
    // invite-then-refuse loop the payload type exists to end. This is why
    // v0.6.8+ must query ONLY the payload shape and never mix the two.
    const result = await graphql({
      schema: publicSchema(),
      source: `
        query {
          fygaroTopupAllowance {
            limit
            allowance { limit }
            unavailableReason
          }
        }
      `,
      rootValue: {
        fygaroTopupAllowance: {
          errors: [],
          allowance: null,
          unavailableReason: "CHECKOUT_DISABLED",
        },
      },
    })

    // Root field is NonNull, so propagation reaches the top: data is null and
    // the reason a pure-modern query would have received is gone.
    expect(result.data).toBeNull()
    expect(result.errors?.length).toBeGreaterThan(0)
  })

  it("still serves the modern payload shape unchanged", async () => {
    // The shim must not disturb the query v0.6.8 will send.
    const result = await graphql({
      schema: publicSchema(),
      source: `
        query {
          fygaroTopupAllowance {
            allowance { limit spent held remaining singlePaymentLimit minimum }
            unavailableReason
          }
        }
      `,
      rootValue: {
        fygaroTopupAllowance: {
          errors: [],
          unavailableReason: null,
          allowance: {
            limit: 12500,
            spent: 0,
            held: 0,
            remaining: 12500,
            singlePaymentLimit: 49900,
            minimum: 1000,
            resetsAt: null,
            holdsExpireAt: null,
          },
        },
      },
    })

    expect(result.errors).toBeUndefined()
    expect(
      (result.data?.fygaroTopupAllowance as { allowance: { remaining: number } })
        .allowance.remaining,
    ).toBe(12500)
  })
})
