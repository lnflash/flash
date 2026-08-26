import { CouldNotFindAccountFromNpubError } from "@domain/errors"
import { AccountsRepository } from "@services/mongoose/accounts"

const findOne = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  Account: { findOne: (...args: unknown[]) => findOne(...args) },
}))

jest.mock("@services/mongoose/utils", () => ({
  toObjectId: jest.fn((id) => id),
  fromObjectId: jest.fn((id) => id),
  parseRepositoryError: jest.fn((err) => err),
}))

const NPUB = ("npub1" + "q".repeat(58)) as Npub

const accountRecord = {
  _id: "account-id",
  id: "5a9f6f45-0a3a-4b0a-9f3e-1e0f9b1b1b1b",
  created_at: new Date(),
  npub: NPUB,
  username: "jaceth2009",
  level: 1,
  statusHistory: [{ status: "active" }],
  contacts: [],
  earn: [],
}

describe("AccountsRepository.findByNpub", () => {
  beforeEach(() => {
    findOne.mockReset()
  })

  it("queries npub with a plain $eq and no collation", async () => {
    // `findOne` here resolves directly — it exposes no `.collation()`. That is
    // the assertion: a non-simple collation cannot use the unique `{ npub: 1 }`
    // index, so every support-desk lookup would be a collection scan. The old
    // implementation chained `.collation({ locale: "en", strength: 2 })` and
    // would blow up on this mock.
    //
    // The `$type` alongside the `$eq` is not decoration: the index is partial
    // on `{ npub: { $type: "string" } }`, and mongo will not use a partial
    // index unless the query provably matches a subset of its filter — which
    // it cannot derive from an equality against a string literal. Without the
    // restated predicate the lookup plans as a COLLSCAN. This mock cannot see
    // that; `test/flash/integration/accounts/npub.spec.ts` explains the real
    // plan and is what actually caught it.
    findOne.mockResolvedValue(accountRecord)

    const result = await AccountsRepository().findByNpub(NPUB)

    expect(findOne).toHaveBeenCalledWith({ npub: { $eq: NPUB, $type: "string" } })
    expect(result).not.toBeInstanceOf(Error)
    expect((result as Account).npub).toBe(NPUB)
  })

  it("reports a miss as an npub miss, not a username miss", async () => {
    // The wrong error class renders as "Account does not exist for username
    // npub1…" in logs and in front of a support agent.
    findOne.mockResolvedValue(null)

    const result = await AccountsRepository().findByNpub(NPUB)

    expect(result).toBeInstanceOf(CouldNotFindAccountFromNpubError)
    expect((result as Error).message).toBe(NPUB)
  })
})
