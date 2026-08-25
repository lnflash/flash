/**
 * `setNpub` used to write whatever the caller sent, with no duplicate check.
 * Combined with `findByNpub` being a `findOne`, two accounts claiming the same
 * npub resolved nondeterministically — and since `accountDetailsByNpub` shipped,
 * that resolution paints a customer's phone/email/level onto a support agent's
 * screen. These tests pin the refusal.
 */
const findByNpub = jest.fn()
const findById = jest.fn()
const update = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findByNpub, findById, update }),
}))

import { CouldNotFindAccountFromNpubError, UnknownRepositoryError } from "@domain/errors"
import { InvalidNpubError, NpubNotAvailableError } from "@domain/nostr"
import { setNpub } from "@app/accounts/set-npub"

const NPUB = ("npub1" + "q".repeat(58)) as Npub
const ACCOUNT_ID = "account-id" as AccountId
const OTHER_ACCOUNT_ID = "other-account-id" as AccountId

describe("Accounts.setNpub", () => {
  beforeEach(() => {
    findByNpub.mockReset().mockResolvedValue(new CouldNotFindAccountFromNpubError(NPUB))
    findById.mockReset().mockResolvedValue({ id: ACCOUNT_ID })
    update.mockReset().mockImplementation(async (account) => account)
  })

  it("links an unclaimed npub", async () => {
    const result = await setNpub({ id: ACCOUNT_ID, npub: NPUB })

    expect(result).toEqual({ id: ACCOUNT_ID, npub: NPUB })
    expect(update).toHaveBeenCalledWith({ id: ACCOUNT_ID, npub: NPUB })
  })

  it("refuses an npub already claimed by another account", async () => {
    // THE IDENTITY COLLISION. Restoring a nostr key on a second account — or
    // deliberately pasting a victim's npub — used to just overwrite.
    findByNpub.mockResolvedValue({ id: OTHER_ACCOUNT_ID, npub: NPUB })

    const result = await setNpub({ id: ACCOUNT_ID, npub: NPUB })

    expect(result).toBeInstanceOf(NpubNotAvailableError)
    expect(update).not.toHaveBeenCalled()
  })

  it("is idempotent when the account already owns the npub", async () => {
    const owned = { id: ACCOUNT_ID, npub: NPUB }
    findByNpub.mockResolvedValue(owned)

    expect(await setNpub({ id: ACCOUNT_ID, npub: NPUB })).toBe(owned)
    expect(update).not.toHaveBeenCalled()
  })

  it("rejects a malformed npub without touching the repository", async () => {
    const result = await setNpub({ id: ACCOUNT_ID, npub: "nope" as Npub })

    expect(result).toBeInstanceOf(InvalidNpubError)
    expect(findByNpub).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("normalises case before claiming", async () => {
    await setNpub({ id: ACCOUNT_ID, npub: ("npub1" + "Q".repeat(58)) as Npub })

    expect(findByNpub).toHaveBeenCalledWith(NPUB)
    expect(update).toHaveBeenCalledWith({ id: ACCOUNT_ID, npub: NPUB })
  })

  it("does not claim the npub when the uniqueness probe itself fails", async () => {
    // A repository failure is not evidence that the npub is free.
    findByNpub.mockResolvedValue(new UnknownRepositoryError("mongo down"))

    const result = await setNpub({ id: ACCOUNT_ID, npub: NPUB })

    expect(result).toBeInstanceOf(UnknownRepositoryError)
    expect(update).not.toHaveBeenCalled()
  })
})
