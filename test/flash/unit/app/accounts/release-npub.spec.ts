/**
 * An npub claim carries no proof of key control and, since the unique index,
 * is permanent: `setNpub` refuses an npub already held by another account, so
 * whoever claims a key first keeps it — including someone who read it off a
 * public relay. `releaseNpub` is the revocation path. Before it, freeing a
 * squatted key meant a hand-written `$unset` against prod mongo.
 */
const unsetNpub = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ unsetNpub }),
}))

import { InvalidAccountIdError } from "@domain/accounts"
import { CouldNotFindAccountError, UnknownRepositoryError } from "@domain/errors"
import { releaseNpub } from "@app/accounts/release-npub"

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e"

describe("Accounts.releaseNpub", () => {
  beforeEach(() => {
    unsetNpub.mockReset().mockResolvedValue({ id: ACCOUNT_ID, username: "jaceth2009" })
  })

  it("clears the npub on the holding account", async () => {
    const result = await releaseNpub(ACCOUNT_ID)

    expect(unsetNpub).toHaveBeenCalledWith(ACCOUNT_ID)
    expect(result).not.toBeInstanceOf(Error)
    expect((result as Account).npub).toBeUndefined()
  })

  it("reports an unknown account instead of reporting a release", async () => {
    unsetNpub.mockResolvedValue(new CouldNotFindAccountError())

    const result = await releaseNpub(ACCOUNT_ID)

    expect(result).toBeInstanceOf(CouldNotFindAccountError)
  })

  it("rejects a malformed account id without writing", async () => {
    const result = await releaseNpub("not-an-account-id")

    expect(result).toBeInstanceOf(InvalidAccountIdError)
    expect(unsetNpub).not.toHaveBeenCalled()
  })

  it("passes through a repository failure", async () => {
    // A failed write is not a release: the operator must not be told the key is
    // free and send the owner off to re-link.
    unsetNpub.mockResolvedValue(new UnknownRepositoryError("mongo down"))

    expect(await releaseNpub(ACCOUNT_ID)).toBeInstanceOf(UnknownRepositoryError)
  })
})
