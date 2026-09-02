/**
 * Schema-execution spec for the admin `accountDetailsByUserPhone` query, built
 * the same way as account-details-by-npub.spec.ts: real field definition, real
 * `Phone` scalar, real resolver, real error map; only the app layer mocked.
 *
 * The case that matters: an orphaned identity — `users` row written, `accounts`
 * row missing — is exactly what an operator looks up by phone when reconciling
 * a failed registration. The repository answers that lookup with
 * CouldNotFindAccountFromKratosIdError, the same domain error the session
 * middleware sees for the caller's OWN session. Here it must read as a
 * not-found for the looked-up user, never as the operator's session being
 * unauthenticated.
 */
const mockGetAccountByUserPhone = jest.fn()
const mockGetUser = jest.fn()

jest.mock("@app", () => ({
  Admin: {
    getAccountByUserPhone: (...args: unknown[]) => mockGetAccountByUserPhone(...args),
  },
  Users: {
    getUser: (...args: unknown[]) => mockGetUser(...args),
  },
  Accounts: { getAccountCapabilities: jest.fn() },
  Wallets: { listWalletsByAccountId: jest.fn() },
  Merchants: { getMerchantsByUsername: jest.fn() },
}))

import { graphql, GraphQLSchema, GraphQLObjectType, GraphQLFieldConfig } from "graphql"

import { CouldNotFindAccountFromKratosIdError } from "@domain/errors"
import AccountDetailsByUserPhoneQuery from "@graphql/admin/root/query/account-details-by-phone"

const PHONE = "+18765550100"
const KRATOS_USER_ID = "ebbe2b32-9a2e-4c77-80e4-5d7347c024bb"

const LOOKUP_QUERY = `
  query accountDetailsByUserPhone($phone: Phone!) {
    accountDetailsByUserPhone(phone: $phone) {
      username
      level
    }
  }
`

const adminSchema = () =>
  new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: {
        accountDetailsByUserPhone:
          AccountDetailsByUserPhoneQuery as unknown as GraphQLFieldConfig<
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
  level: 1,
  kratosUserId: KRATOS_USER_ID,
}

describe("admin accountDetailsByUserPhone", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("resolves an account by phone", async () => {
    mockGetAccountByUserPhone.mockResolvedValue(account)

    const result = await graphql({
      schema: adminSchema(),
      source: LOOKUP_QUERY,
      variableValues: { phone: PHONE },
    })

    expect(result.errors).toBeUndefined()
    expect(mockGetAccountByUserPhone).toHaveBeenCalledWith(PHONE)
    expect(result.data?.accountDetailsByUserPhone).toEqual({
      username: "jaceth2009",
      level: "ONE",
    })
  })

  it("reports an orphaned identity as a not-found for that user, not as the operator's session", async () => {
    mockGetAccountByUserPhone.mockResolvedValue(
      new CouldNotFindAccountFromKratosIdError(KRATOS_USER_ID),
    )

    const result = await graphql({
      schema: adminSchema(),
      source: LOOKUP_QUERY,
      variableValues: { phone: PHONE },
    })

    expect(result.errors?.[0].extensions?.code).toBe("NOT_FOUND")
    expect(result.errors?.[0].extensions?.code).not.toBe("NOT_AUTHENTICATED")
    expect(result.errors?.[0].message).toBe(
      `Account does not exist for user id ${KRATOS_USER_ID}`,
    )
    expect(result.errors?.[0].message).not.toContain("session")
  })
})
