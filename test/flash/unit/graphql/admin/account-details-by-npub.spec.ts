const mockGetAccountByNpub = jest.fn()

jest.mock("@app/index", () => ({
  Admin: {
    getAccountByNpub: (...args: unknown[]) => mockGetAccountByNpub(...args),
  },
}))

import { CouldNotFindAccountFromUsernameError } from "@domain/errors"
import AccountDetailsByNpubQuery from "@graphql/admin/root/query/account-details-by-npub"

const VALID_NPUB = "npub1" + "q".repeat(58)

const resolveQuery = async (npub: unknown) => {
  const resolve = AccountDetailsByNpubQuery.resolve as unknown as (
    source: null,
    args: { npub: unknown },
    ctx: Record<string, unknown>,
  ) => Promise<unknown>

  return resolve(null, { npub }, {})
}

describe("accountDetailsByNpub", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns the account for a known npub", async () => {
    const account = { id: "account-id", username: "jaceth2009", npub: VALID_NPUB }
    mockGetAccountByNpub.mockResolvedValue(account)

    const result = await resolveQuery(VALID_NPUB)

    expect(mockGetAccountByNpub).toHaveBeenCalledWith(VALID_NPUB)
    expect(result).toBe(account)
  })

  it("throws a mapped error when no account matches", async () => {
    mockGetAccountByNpub.mockResolvedValue(
      new CouldNotFindAccountFromUsernameError(VALID_NPUB),
    )

    await expect(resolveQuery(VALID_NPUB)).rejects.toThrow()
  })

  it("rethrows scalar validation errors without hitting the app layer", async () => {
    const validationError = new Error("Invalid value for Npub")

    await expect(resolveQuery(validationError)).rejects.toThrow(
      "Invalid value for Npub",
    )
    expect(mockGetAccountByNpub).not.toHaveBeenCalled()
  })
})
