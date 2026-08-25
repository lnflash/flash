/**
 * An npub claim carries no proof of key control and, since the unique index,
 * is permanent: `setNpub` refuses an npub already held by another account, so
 * whoever claims a key first keeps it — including someone who read it off a
 * public relay. `releaseNpub` is the revocation path. Before it, freeing a
 * squatted key meant a hand-written `$unset` against prod mongo.
 */
const findById = jest.fn()
const unsetNpub = jest.fn()
const claimNpub = jest.fn()
const info = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findById, unsetNpub, claimNpub }),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: (...args: unknown[]) => info(...args) },
}))

import { InvalidAccountIdError } from "@domain/accounts"
import {
  CouldNotFindAccountError,
  CouldNotFindAccountFromIdError,
  DuplicateKeyForPersistError,
  NoNpubToReleaseError,
  UnknownRepositoryError,
} from "@domain/errors"
import { AccountAlreadyHasNpubError, NpubNotAvailableError } from "@domain/nostr"
import { releaseNpub } from "@app/accounts/release-npub"

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e" as AccountId
const TARGET_ACCOUNT_ID = "6a1b2c3d4e5f60718293a4b5" as AccountId
const SUPPORT_USER_ID = "support-user-id" as UserId
const NPUB = `npub1${"q".repeat(58)}` as Npub

const release = (overrides: Record<string, unknown> = {}) =>
  releaseNpub({ id: ACCOUNT_ID, releasedByUserId: SUPPORT_USER_ID, ...overrides })

describe("Accounts.releaseNpub", () => {
  beforeEach(() => {
    findById
      .mockReset()
      .mockResolvedValue({ id: ACCOUNT_ID, username: "jaceth2009", npub: NPUB })
    unsetNpub.mockReset().mockResolvedValue({ id: ACCOUNT_ID, username: "jaceth2009" })
    claimNpub.mockReset()
    info.mockReset()
  })

  it("clears the npub on the holding account and reports which key was freed", async () => {
    const result = await release()

    expect(unsetNpub).toHaveBeenCalledWith(ACCOUNT_ID)
    expect(result).not.toBeInstanceOf(Error)
    expect(result).toMatchObject({ previousNpub: NPUB })
  })

  it("logs the actor, the account and the key that was removed", async () => {
    // The only attribution that exists: the account document keeps no trace of
    // a removed npub, and the admin server's Pino line logs `gqlContext.user`
    // as undefined because its Apollo context never assigns `req.gqlContext`.
    await release()

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        previousNpub: NPUB,
        releasedByUserId: SUPPORT_USER_ID,
      }),
      expect.any(String),
    )
  })

  it("reports an unknown account instead of reporting a release", async () => {
    findById.mockResolvedValue(new CouldNotFindAccountError())

    const result = await release()

    expect(result).toBeInstanceOf(CouldNotFindAccountFromIdError)
    expect(unsetNpub).not.toHaveBeenCalled()
  })

  it("refuses an account that holds no npub", async () => {
    // `$unset` on a document without the field is a no-op that still matches,
    // so without this the operator is told a release happened and sends the
    // owner off to re-link — where the squatter still holds the key.
    findById.mockResolvedValue({ id: ACCOUNT_ID, username: "jaceth2009" })

    const result = await release()

    expect(result).toBeInstanceOf(NoNpubToReleaseError)
    expect(unsetNpub).not.toHaveBeenCalled()
  })

  it("rejects a malformed account id without writing", async () => {
    const result = await releaseNpub({
      id: "not-an-account-id",
      releasedByUserId: SUPPORT_USER_ID,
    })

    expect(result).toBeInstanceOf(InvalidAccountIdError)
    expect(findById).not.toHaveBeenCalled()
    expect(unsetNpub).not.toHaveBeenCalled()
  })

  it("passes through a repository failure", async () => {
    // A failed write is not a release: the operator must not be told the key is
    // free and send the owner off to re-link.
    unsetNpub.mockResolvedValue(new UnknownRepositoryError("mongo down"))

    expect(await release()).toBeInstanceOf(UnknownRepositoryError)
  })

  describe("reassignment", () => {
    beforeEach(() => {
      findById.mockImplementation(async (id: AccountId) =>
        id === ACCOUNT_ID
          ? { id: ACCOUNT_ID, username: "jaceth2009", npub: NPUB }
          : { id: TARGET_ACCOUNT_ID, username: "rightful-owner" },
      )
      claimNpub.mockResolvedValue({
        id: TARGET_ACCOUNT_ID,
        username: "rightful-owner",
        npub: NPUB,
      })
    })

    it("hands the freed key to the target", async () => {
      const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

      expect(unsetNpub).toHaveBeenCalledWith(ACCOUNT_ID)
      expect(claimNpub).toHaveBeenCalledWith(TARGET_ACCOUNT_ID, NPUB)
      expect(result).toMatchObject({
        previousNpub: NPUB,
        reassignedTo: { npub: NPUB },
      })
    })

    it("refuses a target that already holds an npub, before freeing anything", async () => {
      findById.mockImplementation(async (id: AccountId) =>
        id === ACCOUNT_ID
          ? { id: ACCOUNT_ID, username: "jaceth2009", npub: NPUB }
          : { id: TARGET_ACCOUNT_ID, username: "rightful-owner", npub: "npub1other" },
      )

      const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

      expect(result).toBeInstanceOf(AccountAlreadyHasNpubError)
      expect(unsetNpub).not.toHaveBeenCalled()
    })

    it("refuses an unknown target, before freeing anything", async () => {
      findById.mockImplementation(async (id: AccountId) =>
        id === ACCOUNT_ID
          ? { id: ACCOUNT_ID, username: "jaceth2009", npub: NPUB }
          : new CouldNotFindAccountError(),
      )

      const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

      expect(result).toBeInstanceOf(CouldNotFindAccountFromIdError)
      expect(unsetNpub).not.toHaveBeenCalled()
    })

    it("rejects a malformed target id without writing", async () => {
      const result = await release({ reassignToAccountId: "not-an-account-id" })

      expect(result).toBeInstanceOf(InvalidAccountIdError)
      expect(unsetNpub).not.toHaveBeenCalled()
    })

    it("reports a claim lost in the window between the two writes", async () => {
      // The release and the claim are not one transaction — this repository has
      // no mongo sessions — so a squatter can take the key back in between. The
      // unique index catches it; the operator must be told the reassignment did
      // not land.
      claimNpub.mockResolvedValue(new DuplicateKeyForPersistError())

      const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

      expect(result).toBeInstanceOf(NpubNotAvailableError)
    })
  })
})
