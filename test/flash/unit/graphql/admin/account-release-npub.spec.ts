/**
 * `accountReleaseNpub` is the admin-side half of the npub squat remedy: without
 * it the admin surface is read-only and a wrongly-claimed npub can only be
 * freed by hand-editing prod mongo. These tests pin the resolver's contract and
 * its registration on the published admin schema.
 */
const mockReleaseNpub = jest.fn()

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

import fs from "fs"
import path from "path"

import { InvalidAccountIdError } from "@domain/accounts"
import { CouldNotFindAccountError } from "@domain/errors"
import AccountReleaseNpubMutation from "@graphql/admin/root/mutation/account-release-npub"

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e"

type Result = {
  errors: { message: string; code?: string }[]
  accountDetails?: { id: string; npub?: string }
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
    mockReleaseNpub.mockResolvedValue({ id: ACCOUNT_ID, username: "jaceth2009" })
  })

  it("is exposed on the published admin schema", () => {
    // Guards the registration in src/graphql/admin/mutations.ts — unwire it and
    // every resolver-level test here still passes green.
    const sdl = fs.readFileSync(
      path.join(__dirname, "../../../../../src/graphql/admin/schema.graphql"),
      "utf8",
    )
    expect(sdl).toContain(
      "accountReleaseNpub(input: AccountReleaseNpubInput!): AccountDetailPayload!",
    )
    expect(sdl).toContain("input AccountReleaseNpubInput {")
  })

  it("releases the npub and returns the account detail", async () => {
    const result = await resolveMutation({ accountId: ACCOUNT_ID })

    expect(mockReleaseNpub).toHaveBeenCalledWith(ACCOUNT_ID)
    expect(result.errors).toEqual([])
    expect(result.accountDetails?.npub).toBeUndefined()
  })

  it("reports an unknown account instead of reporting a release", async () => {
    // A support agent told the key is free would send the rightful owner off to
    // re-link, and `setNpub` would refuse them again.
    mockReleaseNpub.mockResolvedValue(new CouldNotFindAccountError())

    const result = await resolveMutation({ accountId: ACCOUNT_ID })

    expect(result.accountDetails).toBeUndefined()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toContain("CouldNotFindAccountError")
  })

  it("reports a malformed account id", async () => {
    mockReleaseNpub.mockResolvedValue(new InvalidAccountIdError("not-an-account-id"))

    const result = await resolveMutation({ accountId: "not-an-account-id" })

    expect(result.accountDetails).toBeUndefined()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toContain("InvalidAccountIdError")
  })

  it("surfaces an input coercion failure without calling the app layer", async () => {
    const result = await resolveMutation({ accountId: new Error("Invalid value for ID") })

    expect(result.errors).toEqual([{ message: "Invalid value for ID" }])
    expect(mockReleaseNpub).not.toHaveBeenCalled()
  })
})
