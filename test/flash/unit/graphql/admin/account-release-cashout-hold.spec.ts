/**
 * ENG-889: `accountReleaseCashoutHold` is how ops lift the cash-out hold the
 * Bridge customer status watch places on a restricted or offboarded customer.
 * Nothing lifts it automatically.
 */
const mockReleaseCashoutHold = jest.fn()

// The admin mutation barrel drags in siblings whose service graph opens a
// redis connection at import time.
jest.mock("@services/redis/connection", () => ({
  redis: { on: jest.fn() },
  redisPubSub: { publish: jest.fn(), asyncIterator: jest.fn() },
  redisCache: { cache: jest.fn(), invalidate: jest.fn() },
  disconnectAll: jest.fn(),
}))

jest.mock("@app", () => ({
  Accounts: {
    releaseCashoutHold: (...args: unknown[]) => mockReleaseCashoutHold(...args),
    getAccountCapabilities: jest.fn(),
  },
  Admin: { getAccountByNpub: jest.fn() },
  Users: { getUser: jest.fn() },
  Wallets: { listWalletsByAccountId: jest.fn() },
  Merchants: { getMerchantsByUsername: jest.fn() },
}))

import {
  CouldNotFindAccountFromIdError,
  NoCashoutHoldToReleaseError,
} from "@domain/errors"
import { mutationFields } from "@graphql/admin/mutations"
import AccountReleaseCashoutHoldMutation from "@graphql/admin/root/mutation/account-release-cashout-hold"

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e"

type Result = {
  errors: { message: string; code?: string }[]
  accountDetails?: { id: string; cashoutHold?: unknown }
}

const resolveMutation = async (input: Record<string, unknown>): Promise<Result> => {
  const resolve = AccountReleaseCashoutHoldMutation.resolve as unknown as (
    source: null,
    args: { input: Record<string, unknown> },
    ctx: Record<string, unknown>,
  ) => Promise<Result>

  return resolve(
    null,
    { input },
    {
      logger: { error: jest.fn() },
      user: { id: "support-user-id", roles: ["support"], ip: "127.0.0.1" },
    },
  )
}

describe("accountReleaseCashoutHold", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReleaseCashoutHold.mockResolvedValue({
      account: { id: ACCOUNT_ID, cashoutHold: undefined },
      previousHold: { reason: "r", source: "bridge-customer-status", setAt: new Date() },
    })
  })

  it("is registered as an authed admin mutation", () => {
    expect(mutationFields.authed).toHaveProperty(
      "accountReleaseCashoutHold",
      AccountReleaseCashoutHoldMutation,
    )
    expect(mutationFields.unauthed).not.toHaveProperty("accountReleaseCashoutHold")
  })

  it("releases the hold as the calling admin, with the comment", async () => {
    const result = await resolveMutation({ accountId: ACCOUNT_ID, comment: "reviewed" })

    expect(mockReleaseCashoutHold).toHaveBeenCalledWith({
      id: ACCOUNT_ID,
      releasedByUserId: "support-user-id",
      comment: "reviewed",
    })
    expect(result).toEqual({
      errors: [],
      accountDetails: { id: ACCOUNT_ID, cashoutHold: undefined },
    })
  })

  it("reports an account with no hold as a not-found", async () => {
    mockReleaseCashoutHold.mockResolvedValue(new NoCashoutHoldToReleaseError(ACCOUNT_ID))

    const result = await resolveMutation({ accountId: ACCOUNT_ID })

    expect(result.accountDetails).toBeUndefined()
    expect(result.errors[0].code).toBe("NOT_FOUND")
    expect(result.errors[0].message).toBe(`Account ${ACCOUNT_ID} has no cash-out hold`)
  })

  it("reports an unknown account as a not-found", async () => {
    mockReleaseCashoutHold.mockResolvedValue(
      new CouldNotFindAccountFromIdError(ACCOUNT_ID),
    )

    const result = await resolveMutation({ accountId: ACCOUNT_ID })

    expect(result.errors[0].code).toBe("NOT_FOUND")
  })
})
