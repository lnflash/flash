/**
 * `accountReleaseNpub` is the admin-side half of the npub squat remedy: without
 * it the admin surface is read-only and a wrongly-claimed npub can only be
 * freed by hand-editing prod mongo. These tests pin the resolver's contract and
 * its registration on the admin schema.
 */
const mockReleaseNpub = jest.fn()

// The admin mutation barrel is imported below for the registration guard, and
// it drags in siblings whose service graph opens a redis connection at import
// time — which never resolves in a unit run.
jest.mock("@services/redis/connection", () => ({
  redis: { on: jest.fn() },
  redisPubSub: { publish: jest.fn(), asyncIterator: jest.fn() },
  redisCache: { cache: jest.fn(), invalidate: jest.fn() },
  disconnectAll: jest.fn(),
}))

jest.mock("@app", () => ({
  Accounts: {
    releaseNpub: (...args: unknown[]) => mockReleaseNpub(...args),
    getAccountCapabilities: jest.fn(),
  },
  Admin: { getAccountByNpub: jest.fn() },
  Users: { getUser: jest.fn() },
  Wallets: { listWalletsByAccountId: jest.fn() },
  Merchants: { getMerchantsByUsername: jest.fn() },
}))

import { InvalidAccountIdError } from "@domain/accounts"
import { CouldNotFindAccountFromIdError, NoNpubToReleaseError } from "@domain/errors"
import { AccountAlreadyHasNpubError } from "@domain/nostr"
import { mutationFields } from "@graphql/admin/mutations"
import AccountReleaseNpubMutation from "@graphql/admin/root/mutation/account-release-npub"

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e"
const TARGET_ACCOUNT_ID = "6a1b2c3d4e5f60718293a4b5"
const NPUB = `npub1${"q".repeat(58)}`

type Result = {
  errors: { message: string; code?: string }[]
  accountDetails?: { id: string; npub?: string }
  previousNpub?: string
  reassignedTo?: { id: string; npub?: string }
}

// Mirrors what graphql-admin-server's Apollo `context` fn builds from the
// decoded admin JWT.
const adminContext = () => ({
  logger: { error: jest.fn() },
  user: { id: "support-user-id", roles: ["support"], ip: "127.0.0.1" },
})

const resolveMutation = async (input: Record<string, unknown>): Promise<Result> => {
  const resolve = AccountReleaseNpubMutation.resolve as unknown as (
    source: null,
    args: { input: Record<string, unknown> },
    ctx: Record<string, unknown>,
  ) => Promise<Result>

  return resolve(null, { input }, adminContext())
}

describe("accountReleaseNpub", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReleaseNpub.mockResolvedValue({
      account: { id: ACCOUNT_ID, username: "jaceth2009" },
      previousNpub: NPUB,
    })
  })

  it("is registered as an authed admin mutation", () => {
    // The source of truth, not the checked-in SDL: `MutationType` spreads
    // `unauthed` and `authed` into identical SDL, so `check:sdl` stays green
    // when the field is moved out of the graphql-shield-guarded bucket and
    // becomes callable by any holder of a role-less ERPNext JWT.
    expect(mutationFields.authed).toHaveProperty(
      "accountReleaseNpub",
      AccountReleaseNpubMutation,
    )
    expect(mutationFields.unauthed).not.toHaveProperty("accountReleaseNpub")
  })

  it("releases the npub and reports which key was freed", async () => {
    const result = await resolveMutation({ accountId: ACCOUNT_ID })

    expect(mockReleaseNpub).toHaveBeenCalledWith({
      id: ACCOUNT_ID,
      releasedByUserId: "support-user-id",
      reassignToAccountId: undefined,
    })
    expect(result.errors).toEqual([])
    expect(result.previousNpub).toBe(NPUB)
  })

  it("attributes the release to the calling admin", async () => {
    // The account document keeps no trace of a removed npub, and the admin
    // server never assigns `req.gqlContext`, so its Pino line logs the actor as
    // undefined. Dropping `ctx` here would leave no record of who freed a key.
    await resolveMutation({ accountId: ACCOUNT_ID })

    expect(mockReleaseNpub.mock.calls[0][0]).toMatchObject({
      releasedByUserId: "support-user-id",
    })
  })

  it("passes the reassignment target through and returns the new holder", async () => {
    mockReleaseNpub.mockResolvedValue({
      account: { id: ACCOUNT_ID, username: "jaceth2009" },
      previousNpub: NPUB,
      reassignedTo: { id: TARGET_ACCOUNT_ID, npub: NPUB },
    })

    const result = await resolveMutation({
      accountId: ACCOUNT_ID,
      reassignToAccountId: TARGET_ACCOUNT_ID,
    })

    expect(mockReleaseNpub).toHaveBeenCalledWith({
      id: ACCOUNT_ID,
      releasedByUserId: "support-user-id",
      reassignToAccountId: TARGET_ACCOUNT_ID,
    })
    expect(result.errors).toEqual([])
    expect(result.reassignedTo?.npub).toBe(NPUB)
  })

  it("reports an unknown account as a not-found, not an internal code", async () => {
    // A support agent told the key is free would send the rightful owner off to
    // re-link, and `setNpub` would refuse them again. Both realistic operator
    // mistakes — wrong id, and the uuid pasted where the ObjectId goes — used
    // to surface as a leaked class name or "contact support".
    mockReleaseNpub.mockResolvedValue(new CouldNotFindAccountFromIdError(ACCOUNT_ID))

    const result = await resolveMutation({ accountId: ACCOUNT_ID })

    expect(result.accountDetails).toBeUndefined()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].code).toBe("NOT_FOUND")
    expect(result.errors[0].message).toContain(ACCOUNT_ID)
    expect(result.errors[0].message).not.toContain("contact support")
    expect(result.errors[0].message).not.toContain("CouldNotFind")
  })

  it("reports a malformed account id as a validation failure", async () => {
    mockReleaseNpub.mockResolvedValue(new InvalidAccountIdError("not-an-account-id"))

    const result = await resolveMutation({ accountId: "not-an-account-id" })

    expect(result.accountDetails).toBeUndefined()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].code).toBe("INVALID_INPUT")
    expect(result.errors[0].message).not.toContain("contact support")
    expect(result.errors[0].message).not.toContain("InvalidAccountIdError")
  })

  it("reports an account that holds no npub as a not-found", async () => {
    mockReleaseNpub.mockResolvedValue(new NoNpubToReleaseError(ACCOUNT_ID))

    const result = await resolveMutation({ accountId: ACCOUNT_ID })

    expect(result.errors[0].code).toBe("NOT_FOUND")
    expect(result.previousNpub).toBeUndefined()
  })

  it("reports a reassignment target that already holds a key", async () => {
    mockReleaseNpub.mockResolvedValue(new AccountAlreadyHasNpubError(TARGET_ACCOUNT_ID))

    const result = await resolveMutation({
      accountId: ACCOUNT_ID,
      reassignToAccountId: TARGET_ACCOUNT_ID,
    })

    expect(result.errors[0].code).toBe("INVALID_INPUT")
    expect(result.previousNpub).toBeUndefined()
  })

  it("surfaces an input coercion failure without calling the app layer", async () => {
    const result = await resolveMutation({ accountId: new Error("Invalid value for ID") })

    expect(result.errors).toEqual([{ message: "Invalid value for ID" }])
    expect(mockReleaseNpub).not.toHaveBeenCalled()
  })

  it("surfaces a coercion failure on the reassignment target too", async () => {
    const result = await resolveMutation({
      accountId: ACCOUNT_ID,
      reassignToAccountId: new Error("Invalid value for ID"),
    })

    expect(result.errors).toEqual([{ message: "Invalid value for ID" }])
    expect(mockReleaseNpub).not.toHaveBeenCalled()
  })
})
