import { CouldNotFindAccountFromIdError, NoNpubToReleaseError } from "@domain/errors"
import { AccountAlreadyHasNpubError } from "@domain/nostr"
import { AccountsRepository } from "@services/mongoose/accounts"

const findOneAndUpdate = jest.fn()
const findOne = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  Account: {
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
    findOne: (...args: unknown[]) => findOne(...args),
  },
}))

jest.mock("@services/mongoose/utils", () => ({
  toObjectId: jest.fn((id) => id),
  fromObjectId: jest.fn((id) => id),
  parseRepositoryError: jest.fn((err) => err),
}))

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e" as AccountId
const NPUB = `npub1${"q".repeat(58)}` as Npub

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
    findOneAndUpdate.mockResolvedValue({ ...accountRecord, npub: NPUB })

    const result = await AccountsRepository().unsetNpub(ACCOUNT_ID)

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ACCOUNT_ID },
      { $unset: { npub: "" } },
      { new: false },
    )
    expect(result).not.toBeInstanceOf(Error)
    // The document read back is the pre-update one, which still carries the
    // npub; the account handed to the caller must not.
    expect((result as NpubUnset).account.npub).toBeUndefined()
    // Nothing else can report it. The updated document no longer holds it, and
    // a second read of the account is a later, potentially different, answer.
    expect((result as NpubUnset).previousNpub).toBe(NPUB)
  })

  it("treats a legacy null npub as nothing to release", async () => {
    // The partial index only covers strings, so documents predating it can
    // still hold an explicit `npub: null`. `$unset` on one frees nothing.
    findOneAndUpdate.mockResolvedValue({ ...accountRecord, npub: null })

    expect(await AccountsRepository().unsetNpub(ACCOUNT_ID)).toBeInstanceOf(
      NoNpubToReleaseError,
    )
  })

  it("reports an unknown account", async () => {
    findOneAndUpdate.mockResolvedValue(null)

    expect(await AccountsRepository().unsetNpub(ACCOUNT_ID)).toBeInstanceOf(
      CouldNotFindAccountFromIdError,
    )
  })

  it("refuses an account that held no npub", async () => {
    // `$unset` on a document without the field is a no-op that still matches on
    // `_id`, so the write itself reports success. Support pastes the wrong
    // account id, is told the key is free, and sends the customer off to
    // re-link — where `setNpub` refuses them because the squatter still has it.
    findOneAndUpdate.mockResolvedValue(accountRecord)

    expect(await AccountsRepository().unsetNpub(ACCOUNT_ID)).toBeInstanceOf(
      NoNpubToReleaseError,
    )
  })
})

describe("AccountsRepository.claimNpub", () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset()
    findOne.mockReset()
  })

  it("sets the key only on an account that holds none", async () => {
    findOneAndUpdate.mockResolvedValue({ ...accountRecord, npub: NPUB })

    const result = await AccountsRepository().claimNpub(ACCOUNT_ID, NPUB)

    // The npub guard in the filter is the write-time re-check: the caller's
    // "target holds no npub" read happens before the release round-trip, so a
    // key the target claims in that window must fail the match rather than be
    // silently overwritten. `$not: { $type: "string" }` and not
    // `$exists: false`, because legacy documents hold `npub: null`, which is
    // not a claim.
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ACCOUNT_ID, npub: { $not: { $type: "string" } } },
      { $set: { npub: NPUB } },
      { new: true },
    )
    expect((result as Account).npub).toBe(NPUB)
  })

  it("reports an unknown account", async () => {
    findOneAndUpdate.mockResolvedValue(null)
    findOne.mockResolvedValue(null)

    expect(await AccountsRepository().claimNpub(ACCOUNT_ID, NPUB)).toBeInstanceOf(
      CouldNotFindAccountFromIdError,
    )
  })

  it("refuses to overwrite a key the account claimed concurrently", async () => {
    // The unique index cannot catch this case — it prevents duplicates, not
    // overwrites. Without the filter guard, the $set would land, the target's
    // just-claimed key would become unclaimed, and nothing would log it.
    findOneAndUpdate.mockResolvedValue(null)
    findOne.mockResolvedValue({ ...accountRecord, npub: `npub1${"z".repeat(58)}` })

    expect(await AccountsRepository().claimNpub(ACCOUNT_ID, NPUB)).toBeInstanceOf(
      AccountAlreadyHasNpubError,
    )
  })
})
