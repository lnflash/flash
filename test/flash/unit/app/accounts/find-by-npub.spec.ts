/**
 * `Accounts.findByNpub` is the one implementation behind both this name and
 * `Admin.getAccountByNpub`, which re-exports it. It never had the normalisation
 * the admin path did; once the case-insensitive collation came off the
 * repository query, normalising here stopped being optional.
 */
const findByNpub = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findByNpub }),
}))

import { InvalidNpubError } from "@domain/nostr"
import { findByNpub as findAccountByNpub } from "@app/accounts/find-by-npub"

const NPUB = ("npub1" + "q".repeat(58)) as Npub

describe("Accounts.findByNpub", () => {
  beforeEach(() => {
    findByNpub.mockReset()
  })

  it("hands a valid npub to the repository", async () => {
    const account = { id: "account-id", npub: NPUB }
    findByNpub.mockResolvedValue(account)

    expect(await findAccountByNpub(NPUB)).toBe(account)
    expect(findByNpub).toHaveBeenCalledWith(NPUB)
  })

  it("normalises case before querying", async () => {
    // The repository query is a plain `$eq` with no collation. Unnormalised,
    // a mixed-case npub from a script or a backfill is a silent not-found on a
    // real user — which the public `isFlashNpub` query reports as false.
    findByNpub.mockResolvedValue({ id: "account-id" })

    await findAccountByNpub(("npub1" + "Q".repeat(58)) as Npub)

    expect(findByNpub).toHaveBeenCalledWith(NPUB)
  })

  it("rejects a malformed npub instead of querying with it", async () => {
    const result = await findAccountByNpub("not-an-npub" as Npub)

    expect(result).toBeInstanceOf(InvalidNpubError)
    expect(findByNpub).not.toHaveBeenCalled()
  })
})
