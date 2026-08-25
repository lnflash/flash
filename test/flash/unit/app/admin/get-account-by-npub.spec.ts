/**
 * `Admin.getAccountByNpub` is the only genuinely new app-layer code behind the
 * admin npub lookup, and it was previously reachable only through a mocked
 * `@app` barrel — i.e. not covered at all. Here the repository is the mock and
 * the app function is real.
 */
const findByNpub = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({ findByNpub }),
  UsersRepository: () => ({}),
}))

import { InvalidNpubError } from "@domain/nostr"
import { getAccountByNpub } from "@app/admin/get-account-by-npub"

const NPUB = ("npub1" + "q".repeat(58)) as Npub

describe("Admin.getAccountByNpub", () => {
  beforeEach(() => {
    findByNpub.mockReset()
  })

  it("hands a valid npub to the repository", async () => {
    const account = { id: "account-id", npub: NPUB }
    findByNpub.mockResolvedValue(account)

    expect(await getAccountByNpub(NPUB)).toBe(account)
    expect(findByNpub).toHaveBeenCalledWith(NPUB)
  })

  it("normalises case before querying", async () => {
    // The repository query is a plain `$eq` with no collation, so normalisation
    // has to happen before it or a mixed-case npub is a false not-found.
    findByNpub.mockResolvedValue({ id: "account-id" })

    await getAccountByNpub(("npub1" + "Q".repeat(58)) as Npub)

    expect(findByNpub).toHaveBeenCalledWith(NPUB)
  })

  it("rejects a malformed npub instead of querying with it", async () => {
    // Defence in depth for callers that are NOT the GraphQL boundary — a
    // script, a backfill, a REST shim. Before the fix the parameter was a raw
    // `string` laundered with `as Npub`, so those callers got a silent
    // not-found rather than a validation error.
    const result = await getAccountByNpub("not-an-npub" as Npub)

    expect(result).toBeInstanceOf(InvalidNpubError)
    expect(findByNpub).not.toHaveBeenCalled()
  })
})
