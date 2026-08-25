import { CouldNotFindAccountError } from "@domain/errors"
import { AccountsRepository } from "@services/mongoose/accounts"

const findOneAndUpdate = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  Account: { findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args) },
}))

jest.mock("@services/mongoose/utils", () => ({
  toObjectId: jest.fn((id) => id),
  fromObjectId: jest.fn((id) => id),
  parseRepositoryError: jest.fn((err) => err),
}))

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e" as AccountId

const accountRecord = {
  _id: ACCOUNT_ID,
  id: "5a9f6f45-0a3a-4b0a-9f3e-1e0f9b1b1b1b",
  created_at: new Date(),
  username: "jaceth2009",
  level: 1,
  statusHistory: [{ status: "active" }],
  contacts: [],
  earn: [],
}

describe("AccountsRepository.unsetNpub", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset()
  })

  it("removes the field rather than blanking it", async () => {
    // `$unset`, not `npub: undefined` (mongoose strips undefined keys from an
    // update doc, so that is a silent no-op) and not `npub: null` (the partial
    // index excludes non-strings, so a null would sit there unindexed and keep
    // failing lookups). Removed means the key is genuinely unclaimed again.
    findOneAndUpdate.mockResolvedValue(accountRecord)

    const result = await AccountsRepository().unsetNpub(ACCOUNT_ID)

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ACCOUNT_ID },
      { $unset: { npub: "" } },
      { new: true },
    )
    expect(result).not.toBeInstanceOf(Error)
    expect((result as Account).npub).toBeUndefined()
  })

  it("reports an unknown account", async () => {
    findOneAndUpdate.mockResolvedValue(null)

    expect(await AccountsRepository().unsetNpub(ACCOUNT_ID)).toBeInstanceOf(
      CouldNotFindAccountError,
    )
  })
})
