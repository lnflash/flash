import { Account } from "@services/mongoose/schema"

describe("accounts.npub index", () => {
  it("is unique, so an npub can only resolve to one account", () => {
    // Without this, `setNpub`'s duplicate check is racy and `findByNpub` — now
    // a support-desk identity resolver — can return either of two colliding
    // accounts. The migration 20260824120000-accounts-unique-npub builds it in
    // prod after deduping.
    const npubIndex = Account.schema
      .indexes()
      .find(([fields]) => Object.keys(fields).join(",") === "npub")

    expect(npubIndex).toBeDefined()

    const [, options] = npubIndex as [Record<string, unknown>, Record<string, unknown>]
    expect(options.unique).toBe(true)
    // `partialFilterExpression`, not `sparse`: a sparse index still indexes
    // documents holding an explicit `npub: null`, and the second such document
    // would collide.
    expect(options.partialFilterExpression).toEqual({ npub: { $type: "string" } })
    expect(options.sparse).toBeUndefined()
  })
})
