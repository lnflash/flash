/**
 * Schema-execution spec for the admin `accountDetailsByNpub` query.
 *
 * Deliberately NOT a direct `.resolve(...)` call. Calling the resolver by hand
 * covers only the eight lines of boilerplate and leaves the two things that
 * actually broke untested: the `Npub` scalar's coercion (its `parseLiteral`
 * shipped without a `return`, rejecting every inline-literal npub) and the
 * query's registration on the admin schema (deleting that line was invisible
 * to the old spec).
 *
 * So: real field definition, real `Npub` scalar, real resolver, real error map,
 * and the committed SDL for registration. Only the app layer is mocked — it is
 * the boundary this file is not responsible for.
 */
const mockGetAccountByNpub = jest.fn()
const mockGetUser = jest.fn()

jest.mock("@app", () => ({
  Admin: {
    getAccountByNpub: (...args: unknown[]) => mockGetAccountByNpub(...args),
  },
  Users: {
    getUser: (...args: unknown[]) => mockGetUser(...args),
  },
  Accounts: { getAccountCapabilities: jest.fn() },
  Wallets: { listWalletsByAccountId: jest.fn() },
  Merchants: { getMerchantsByUsername: jest.fn() },
}))

import fs from "fs"
import path from "path"

import {
  graphql,
  parse,
  validate,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLFieldConfig,
} from "graphql"

import { CouldNotFindAccountFromNpubError } from "@domain/errors"
import AccountDetailsByNpubQuery from "@graphql/admin/root/query/account-details-by-npub"

const VALID_NPUB = "npub1" + "q".repeat(58)
const UPPERCASE_NPUB = "npub1" + "Q".repeat(58)
const MALFORMED_NPUB = "npub1toshort"

/**
 * The consumer's actual document — frappe-flash-admin
 * `admin_panel/api/support_lookup.py` paints these fields onto a Chatwoot
 * contact card.
 */
const SUPPORT_LOOKUP_QUERY = `
  query accountDetailsByNpub($npub: npub!) {
    accountDetailsByNpub(npub: $npub) {
      npub
      username
      level
      owner {
        phone
      }
    }
  }
`

const literalQuery = (npub: string) => `
  query {
    accountDetailsByNpub(npub: "${npub}") {
      npub
      username
      level
      owner {
        phone
      }
    }
  }
`

// One-field schema over the REAL field definition, so the scalar and the
// resolver both run. Two things this deliberately is not. It is not
// `buildSchema` over the checked-in SDL: that yields a default resolver and a
// stub scalar, and would pass with the feature deleted. And it is not
// `@graphql/admin/queries`: importing that barrel drags in the cash-wallet
// cutover query, which constructs Redis clients at import time and hangs the
// runner — registration is asserted against the committed SDL instead.
const adminSchema = () =>
  new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: {
        accountDetailsByNpub: AccountDetailsByNpubQuery as unknown as GraphQLFieldConfig<
          unknown,
          unknown
        >,
      },
    }),
  })

const account = {
  id: "account-id",
  uuid: "5a9f6f45-0a3a-4b0a-9f3e-1e0f9b1b1b1b",
  username: "jaceth2009",
  npub: VALID_NPUB,
  level: 1,
  kratosUserId: "kratos-user-id",
}

const owner = {
  id: "kratos-user-id",
  phone: "+18765550100",
  language: "en",
  createdAt: new Date(1787340000 * 1000),
}

describe("admin accountDetailsByNpub", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetUser.mockResolvedValue(owner)
  })

  it("is exposed on the published admin schema", () => {
    // Guards the registration in src/graphql/admin/queries.ts. Unwire it and
    // every resolver-level test still passes green, so assert the field the
    // consumer actually calls exists on the committed SDL — which `yarn
    // check:sdl` keeps in lockstep with the code.
    const sdl = fs.readFileSync(
      path.join(__dirname, "../../../../../src/graphql/admin/schema.graphql"),
      "utf8",
    )
    expect(sdl).toContain("accountDetailsByNpub(npub: npub!): AuditedAccount!")
    expect(sdl).toContain("scalar npub")
  })

  it("validates the consumer's document against the real field", () => {
    expect(validate(adminSchema(), parse(SUPPORT_LOOKUP_QUERY))).toHaveLength(0)
  })

  it("resolves the support-lookup document through a variable", async () => {
    mockGetAccountByNpub.mockResolvedValue(account)

    const result = await graphql({
      schema: adminSchema(),
      source: SUPPORT_LOOKUP_QUERY,
      variableValues: { npub: VALID_NPUB },
    })

    expect(result.errors).toBeUndefined()
    expect(mockGetAccountByNpub).toHaveBeenCalledWith(VALID_NPUB)
    expect(result.data?.accountDetailsByNpub).toEqual({
      npub: VALID_NPUB,
      username: "jaceth2009",
      level: "ONE",
      owner: { phone: "+18765550100" },
    })
  })

  it("resolves the same npub written as an inline literal", async () => {
    // THE REGRESSION. `parseLiteral` returned undefined on its success branch,
    // which graphql-js reads as failed coercion: every inline-literal npub was
    // rejected at validation time with "Expected value of type npub!" — a
    // perfectly valid key reported as malformed to anyone in GraphiQL.
    mockGetAccountByNpub.mockResolvedValue(account)

    const source = literalQuery(VALID_NPUB)
    expect(validate(adminSchema(), parse(source))).toHaveLength(0)

    const result = await graphql({ schema: adminSchema(), source })

    expect(result.errors).toBeUndefined()
    expect(mockGetAccountByNpub).toHaveBeenCalledWith(VALID_NPUB)
    expect(result.data?.accountDetailsByNpub).toMatchObject({ npub: VALID_NPUB })
  })

  it("normalises case identically on both coercion paths", async () => {
    // The repository query is a plain `$eq` with no collation, so the scalar is
    // the only thing standing between a mixed-case npub and a false not-found.
    mockGetAccountByNpub.mockResolvedValue(account)

    await graphql({
      schema: adminSchema(),
      source: SUPPORT_LOOKUP_QUERY,
      variableValues: { npub: UPPERCASE_NPUB },
    })
    await graphql({ schema: adminSchema(), source: literalQuery(UPPERCASE_NPUB) })

    expect(mockGetAccountByNpub).toHaveBeenNthCalledWith(1, VALID_NPUB)
    expect(mockGetAccountByNpub).toHaveBeenNthCalledWith(2, VALID_NPUB)
  })

  it("rejects a malformed npub variable before it reaches the app layer", async () => {
    const result = await graphql({
      schema: adminSchema(),
      source: SUPPORT_LOOKUP_QUERY,
      variableValues: { npub: MALFORMED_NPUB },
    })

    expect(result.errors?.length).toBeGreaterThan(0)
    expect(mockGetAccountByNpub).not.toHaveBeenCalled()
  })

  it("rejects a malformed npub literal before it reaches the app layer", async () => {
    const result = await graphql({
      schema: adminSchema(),
      source: literalQuery(MALFORMED_NPUB),
    })

    expect(result.errors?.length).toBeGreaterThan(0)
    expect(mockGetAccountByNpub).not.toHaveBeenCalled()
  })

  it("reports a miss as an npub miss, not a username miss", async () => {
    // The not-found path of a support-desk lookup lands in logs and in front of
    // humans. Before the fix the repository returned
    // CouldNotFindAccountFromUsernameError, so the operator was told
    // "Account does not exist for username npub1…".
    mockGetAccountByNpub.mockResolvedValue(
      new CouldNotFindAccountFromNpubError(VALID_NPUB),
    )

    const result = await graphql({
      schema: adminSchema(),
      source: SUPPORT_LOOKUP_QUERY,
      variableValues: { npub: VALID_NPUB },
    })

    expect(result.errors?.[0].message).toBe(
      `Account does not exist for npub ${VALID_NPUB}`,
    )
    expect(result.errors?.[0].message).not.toContain("username")
    // The consumer keys off the NOT_FOUND code, so the 404 path is unchanged.
    expect(result.errors?.[0].extensions?.code).toBe("NOT_FOUND")
  })
})
