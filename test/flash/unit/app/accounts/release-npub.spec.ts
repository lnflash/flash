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
const warn = jest.fn()
const error = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findById, unsetNpub, claimNpub }),
}))

jest.mock("@services/logger", () => ({
  baseLogger: {
    info: (...args: unknown[]) => info(...args),
    warn: (...args: unknown[]) => warn(...args),
    error: (...args: unknown[]) => error(...args),
  },
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
    findById.mockReset()
    unsetNpub.mockReset().mockResolvedValue({
      account: { id: ACCOUNT_ID, username: "jaceth2009" },
      previousNpub: NPUB,
    })
    claimNpub.mockReset()
    info.mockReset()
    warn.mockReset()
    error.mockReset()
  })

  it("clears the npub on the holding account and reports which key was freed", async () => {
    const result = await release()

    expect(unsetNpub).toHaveBeenCalledWith(ACCOUNT_ID)
    expect(result).not.toBeInstanceOf(Error)
    expect(result).toMatchObject({ previousNpub: NPUB })
  })

  it("takes the freed key from the write itself rather than re-reading the holder", async () => {
    // A second read is a later answer: if the holder re-links between the two,
    // the log and the reassignment would carry a key the `$unset` never
    // removed. `unsetNpub` reads the pre-update document and is the only
    // reader that cannot disagree with itself.
    const result = await release()

    expect(findById).not.toHaveBeenCalled()
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
    unsetNpub.mockResolvedValue(new CouldNotFindAccountFromIdError(ACCOUNT_ID))

    const result = await release()

    expect(result).toBeInstanceOf(CouldNotFindAccountFromIdError)
    expect(claimNpub).not.toHaveBeenCalled()
  })

  it("refuses an account that holds no npub", async () => {
    // `$unset` on a document without the field is a no-op that still matches,
    // so without this the operator is told a release happened and sends the
    // owner off to re-link — where the squatter still holds the key.
    unsetNpub.mockResolvedValue(new NoNpubToReleaseError(ACCOUNT_ID))

    const result = await release()

    expect(result).toBeInstanceOf(NoNpubToReleaseError)
    expect(claimNpub).not.toHaveBeenCalled()
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

  describe("refusal logging", () => {
    /**
     * A stolen admin token enumerating account ids produces one line for the id
     * that happened to hold a key and nothing at all for the rest, which is the
     * shape an investigator needs to see the sweep. The admin server's Pino
     * request line cannot supply it: it carries neither the actor nor the body.
     */
    const refusals: [string, () => Promise<unknown>, string][] = [
      [
        "a malformed account id",
        () => releaseNpub({ id: "not-an-account-id", releasedByUserId: SUPPORT_USER_ID }),
        // The id as given, not a checked one — there is no checked one here,
        // and the string the caller sent is what an investigator matches on.
        "not-an-account-id",
      ],
      [
        "a malformed reassignment target id",
        () => release({ reassignToAccountId: "not-an-account-id" }),
        ACCOUNT_ID,
      ],
      [
        "an unknown holder",
        async () => {
          unsetNpub.mockResolvedValue(new CouldNotFindAccountFromIdError(ACCOUNT_ID))
          return release()
        },
        ACCOUNT_ID,
      ],
      [
        "a holder with no npub",
        async () => {
          unsetNpub.mockResolvedValue(new NoNpubToReleaseError(ACCOUNT_ID))
          return release()
        },
        ACCOUNT_ID,
      ],
      [
        "an unknown reassignment target",
        async () => {
          findById.mockResolvedValue(new CouldNotFindAccountError())
          return release({ reassignToAccountId: TARGET_ACCOUNT_ID })
        },
        ACCOUNT_ID,
      ],
      [
        "a reassignment target that already holds a key",
        async () => {
          findById.mockResolvedValue({ id: TARGET_ACCOUNT_ID, npub: NPUB })
          return release({ reassignToAccountId: TARGET_ACCOUNT_ID })
        },
        ACCOUNT_ID,
      ],
    ]

    it.each(refusals)(
      "logs a refused release for %s",
      async (_label, run, expectedAccountId) => {
        await run()

        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: expectedAccountId,
            releasedByUserId: SUPPORT_USER_ID,
            reason: expect.any(String),
          }),
          expect.any(String),
        )
        expect(info).not.toHaveBeenCalled()
      },
    )

    it("does not log a refusal when the release succeeds", async () => {
      await release()

      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe("reassignment", () => {
    beforeEach(() => {
      findById.mockResolvedValue({ id: TARGET_ACCOUNT_ID, username: "rightful-owner" })
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

    it("accepts a target carrying a legacy null npub", async () => {
      // The partial index only covers string npubs and the migration leaves
      // `npub: null` documents alone, so an account that never linked a key can
      // still hold an explicit null. Reading that as a claim would make the
      // account permanently unable to receive a reassignment.
      findById.mockResolvedValue({ id: TARGET_ACCOUNT_ID, npub: null })

      const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

      expect(result).not.toBeInstanceOf(Error)
      expect(claimNpub).toHaveBeenCalledWith(TARGET_ACCOUNT_ID, NPUB)
    })

    it("refuses a target that already holds an npub, before freeing anything", async () => {
      findById.mockResolvedValue({
        id: TARGET_ACCOUNT_ID,
        username: "rightful-owner",
        npub: "npub1other",
      })

      const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

      expect(result).toBeInstanceOf(AccountAlreadyHasNpubError)
      expect(unsetNpub).not.toHaveBeenCalled()
    })

    it("refuses an unknown target, before freeing anything", async () => {
      findById.mockResolvedValue(new CouldNotFindAccountError())

      const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

      expect(result).toBeInstanceOf(CouldNotFindAccountFromIdError)
      expect(unsetNpub).not.toHaveBeenCalled()
    })

    it("rejects a malformed target id without writing", async () => {
      const result = await release({ reassignToAccountId: "not-an-account-id" })

      expect(result).toBeInstanceOf(InvalidAccountIdError)
      expect(unsetNpub).not.toHaveBeenCalled()
    })

    it("records the target as intent before the claim, and as outcome after", async () => {
      // The claim can still lose to a concurrent one, so the release line must
      // not assert where the key went — an investigator reading it would put
      // the key on an account that never received it.
      await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

      expect(info).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ reassignToAccountId: TARGET_ACCOUNT_ID }),
        expect.any(String),
      )
      expect(info.mock.calls[0][0]).not.toHaveProperty("reassignedToAccountId")
      expect(info).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          reassignedToAccountId: TARGET_ACCOUNT_ID,
          previousNpub: NPUB,
          releasedByUserId: SUPPORT_USER_ID,
        }),
        expect.any(String),
      )
    })

    describe("when the claim fails after the release landed", () => {
      beforeEach(() => {
        claimNpub.mockResolvedValue(new DuplicateKeyForPersistError())
      })

      it("reports a claim lost in the window between the two writes", async () => {
        // The release and the claim are not one transaction — this repository
        // has no mongo sessions — so a squatter can take the key back in
        // between. The unique index catches it; the operator must be told the
        // reassignment did not land.
        const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

        expect(result).toMatchObject({
          reassignmentError: expect.any(NpubNotAvailableError),
        })
      })

      it("still reports the release that did land", async () => {
        // Returning a bare error would discard both, leaving the operator
        // unaware that the key is now unclaimed and that re-running the
        // mutation refuses with `NoNpubToReleaseError`. `previousNpub` is what
        // they feed to `accountDetailsByNpub` to find the new holder.
        const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

        expect(result).not.toBeInstanceOf(Error)
        expect(result).toMatchObject({
          account: { id: ACCOUNT_ID },
          previousNpub: NPUB,
        })
        expect(result).not.toMatchObject({ reassignedTo: expect.anything() })
      })

      it("logs the partial application rather than a reassignment", async () => {
        await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: ACCOUNT_ID,
            previousNpub: NPUB,
            reassignToAccountId: TARGET_ACCOUNT_ID,
            releasedByUserId: SUPPORT_USER_ID,
          }),
          expect.any(String),
        )
        expect(info).toHaveBeenCalledTimes(1)
      })

      it("passes a non-collision claim failure through the same way", async () => {
        claimNpub.mockResolvedValue(new UnknownRepositoryError("mongo down"))

        const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

        expect(result).toMatchObject({
          previousNpub: NPUB,
          reassignmentError: expect.any(UnknownRepositoryError),
        })
      })

      it("reports a target that claimed a different key after the pre-release check", async () => {
        // The "target holds no npub" check above is a read from before the
        // release round-trip. If the target links a different key via
        // `userUpdateNpub` in that window, `claimNpub`'s write-time filter
        // refuses rather than silently overwriting the just-claimed key — and
        // the refusal must reach the operator as a reassignment failure on an
        // otherwise-landed release, not vanish.
        claimNpub.mockResolvedValue(new AccountAlreadyHasNpubError(TARGET_ACCOUNT_ID))

        const result = await release({ reassignToAccountId: TARGET_ACCOUNT_ID })

        expect(result).not.toBeInstanceOf(Error)
        expect(result).toMatchObject({
          previousNpub: NPUB,
          reassignmentError: expect.any(AccountAlreadyHasNpubError),
        })
        expect(result).not.toMatchObject({ reassignedTo: expect.anything() })
      })
    })
  })
})
