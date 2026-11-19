/**
 * ENG-889: `accountPlaceCashoutHold` is how ops hold cash-outs by hand, for
 * example for a customer the Bridge customer status watch's first run listed
 * as already restricted or offboarded. The hold is attributed to the calling
 * admin, and an existing hold is never replaced.
 */
const mockPlaceCashoutHoldByAdmin = jest.fn()

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
    placeCashoutHoldByAdmin: (...args: unknown[]) => mockPlaceCashoutHoldByAdmin(...args),
    getAccountCapabilities: jest.fn(),
  },
  Admin: { getAccountByNpub: jest.fn() },
  Users: { getUser: jest.fn() },
  Wallets: { listWalletsByAccountId: jest.fn() },
  Merchants: { getMerchantsByUsername: jest.fn() },
}))

import { InvalidAccountIdError } from "@domain/accounts"
import { CouldNotFindAccountFromIdError } from "@domain/errors"
import { mutationFields } from "@graphql/admin/mutations"
import AccountPlaceCashoutHoldMutation from "@graphql/admin/root/mutation/account-place-cashout-hold"

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e"

type Result = {
  errors: { message: string; code?: string }[]
  accountDetails?: { id: string; cashoutHold?: unknown }
}

const resolveMutation = async (input: Record<string, unknown>): Promise<Result> => {
  const resolve = AccountPlaceCashoutHoldMutation.resolve as unknown as (
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

const opsHold = {
  reason: "baseline: already offboarded",
  source: "admin",
  setAt: new Date("2026-11-19T00:00:00Z"),
  setByUserId: "support-user-id",
}

const watcherHold = {
  reason: "Bridge customer cust_1 went from active to offboarded",
  source: "bridge-customer-status",
  setAt: new Date("2026-11-18T00:00:00Z"),
}

describe("accountPlaceCashoutHold", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPlaceCashoutHoldByAdmin.mockResolvedValue({
      placed: true,
      account: { id: ACCOUNT_ID, cashoutHold: opsHold },
    })
  })

  it("is registered as an authed admin mutation", () => {
    expect(mutationFields.authed).toHaveProperty(
      "accountPlaceCashoutHold",
      AccountPlaceCashoutHoldMutation,
    )
    expect(mutationFields.unauthed).not.toHaveProperty("accountPlaceCashoutHold")
  })

  it("places the hold as the calling admin, with the reason", async () => {
    const result = await resolveMutation({
      accountId: ACCOUNT_ID,
      reason: "  baseline: already offboarded ",
    })

    expect(mockPlaceCashoutHoldByAdmin).toHaveBeenCalledWith({
      id: ACCOUNT_ID,
      reason: "baseline: already offboarded",
      placedByUserId: "support-user-id",
    })
    expect(result).toEqual({
      errors: [],
      accountDetails: { id: ACCOUNT_ID, cashoutHold: opsHold },
    })
  })

  it("reports the existing hold, untouched, when the account is already held", async () => {
    mockPlaceCashoutHoldByAdmin.mockResolvedValue({
      placed: false,
      account: { id: ACCOUNT_ID, cashoutHold: watcherHold },
    })

    const result = await resolveMutation({ accountId: ACCOUNT_ID, reason: "review" })

    expect(result.errors).toEqual([])
    expect(result.accountDetails?.cashoutHold).toEqual(watcherHold)
  })

  it("refuses an empty reason without touching the account", async () => {
    const result = await resolveMutation({ accountId: ACCOUNT_ID, reason: "   " })

    expect(result.errors[0].message).toBe("A reason is required")
    expect(mockPlaceCashoutHoldByAdmin).not.toHaveBeenCalled()
  })

  it("reports a malformed account id as an error", async () => {
    mockPlaceCashoutHoldByAdmin.mockResolvedValue(new InvalidAccountIdError("bad"))

    const result = await resolveMutation({ accountId: "not-an-id", reason: "review" })

    expect(result.accountDetails).toBeUndefined()
    expect(result.errors).toHaveLength(1)
  })

  it("reports an unknown account as a not-found", async () => {
    mockPlaceCashoutHoldByAdmin.mockResolvedValue(
      new CouldNotFindAccountFromIdError(ACCOUNT_ID),
    )

    const result = await resolveMutation({ accountId: ACCOUNT_ID, reason: "review" })

    expect(result.errors[0].code).toBe("NOT_FOUND")
  })
})
