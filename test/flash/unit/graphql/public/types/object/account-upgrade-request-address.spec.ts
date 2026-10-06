const mockGetUpgradeVerification = jest.fn()

jest.mock("@app", () => ({
  Accounts: {
    getUpgradeVerification: (...args: unknown[]) => mockGetUpgradeVerification(...args),
  },
}))

import { graphql, GraphQLNonNull, GraphQLObjectType, GraphQLSchema } from "graphql"

import AccountUpgradeRequestPayload from "@graphql/public/types/payload/account-upgrade-request"
import { AccountUpgradeRequest } from "@services/frappe/models/AccountUpgradeRequest"

/**
 * The app's document, verbatim from flash-mobile `app/graphql/front-end-queries.ts`
 * (main, 2026-10-06). Held as a literal because its value is being what shipped
 * builds send: it selects every non-null Address field.
 */
const LATEST_UPGRADE_REQUEST_QUERY = `
  query LatestAccountUpgradeRequest {
    latestAccountUpgradeRequest {
      errors {
        code
        message
      }
      upgradeRequest {
        address {
          city
          country
          line1
          line2
          postalCode
          state
          title
        }
        bankAccount {
          accountName
          accountNumber
          accountType
          bankBranch
          bankName
          currency
          id
          isDefault
        }
        currentLevel
        fullName
        terminalsRequested
        status
        requestedLevel
        phoneNumber
        email
        idDocument
        verification {
          status
          reasonCode
          reasonMessage
          reviewedAt
        }
      }
    }
  }
`

/**
 * A one-field schema around the REAL payload type, so the real field resolvers
 * run (and not the assembled main schema, which builds Redis and Mongo clients
 * at import). The non-null root mirrors the real query.
 */
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      latestAccountUpgradeRequest: {
        type: new GraphQLNonNull(AccountUpgradeRequestPayload),
        resolve: (root: { payload: unknown }) => root.payload,
      },
    },
  }),
})

// An ERPNext row as the Bridge KYC auto-upgrade (frappe-flash-admin
// bridge_kyc_upgrade) leaves it: approved, no address, no bank account.
const bridgeKycRow = {
  name: "AUR-0001",
  username: "creech147",
  current_level: "ONE",
  requested_level: "TWO",
  status: "Approved",
  full_name: "William Creech",
  phone_number: "+16065550123",
  email: "will@example.com",
  id_document: "",
  address_title: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  pincode: null,
  country: null,
  terminal_requested: 0,
  decision_reason: "APPROVE_BRIDGE_KYC",
} as unknown as Parameters<typeof AccountUpgradeRequest.fromErpnext>[0]

type LatestUpgradeRequestData = {
  latestAccountUpgradeRequest: {
    upgradeRequest: {
      address: Record<string, string | null>
      requestedLevel: string
      verification: { reasonCode: string | null }
    }
  }
}

const run = async (row: Parameters<typeof AccountUpgradeRequest.fromErpnext>[0]) => {
  const result = await graphql({
    schema,
    source: LATEST_UPGRADE_REQUEST_QUERY,
    rootValue: {
      payload: { errors: [], upgradeRequest: AccountUpgradeRequest.fromErpnext(row) },
    },
  })
  return {
    errors: result.errors,
    data: result.data as LatestUpgradeRequestData | undefined,
  }
}

beforeEach(() => {
  mockGetUpgradeVerification.mockReset()
  mockGetUpgradeVerification.mockResolvedValue({
    status: "APPROVED",
    reasonCode: "APPROVE_BRIDGE_KYC",
    reasonMessage: "Your identity was confirmed through your completed KYC.",
  })
})

describe("AccountUpgradeRequest.address", () => {
  it("resolves a request filed without an address instead of failing the query", async () => {
    const result = await run(bridgeKycRow)

    expect(result.errors).toBeUndefined()
    const upgradeRequest = result.data?.latestAccountUpgradeRequest.upgradeRequest
    expect(upgradeRequest?.address).toEqual({
      city: "",
      country: "",
      line1: "",
      line2: null,
      postalCode: null,
      state: "",
      title: "",
    })
    expect(upgradeRequest?.requestedLevel).toBe("TWO")
    expect(upgradeRequest?.verification.reasonCode).toBe("APPROVE_BRIDGE_KYC")
  })

  it("returns a submitted address unchanged", async () => {
    const result = await run({
      ...bridgeKycRow,
      address_title: "Home",
      address_line1: "1 Main St",
      address_line2: "Apt 2",
      city: "Kingston",
      state: "St. Andrew",
      pincode: "JMAAW01",
      country: "Jamaica",
    })

    expect(result.errors).toBeUndefined()
    expect(result.data?.latestAccountUpgradeRequest.upgradeRequest.address).toEqual({
      city: "Kingston",
      country: "Jamaica",
      line1: "1 Main St",
      line2: "Apt 2",
      postalCode: "JMAAW01",
      state: "St. Andrew",
      title: "Home",
    })
  })
})
