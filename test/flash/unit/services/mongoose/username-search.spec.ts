import { searchUsernameCandidates } from "@services/mongoose/username-search"

const find = jest.fn()
jest.mock("@services/mongoose/schema", () => ({
  Account: { find: (...args: unknown[]) => find(...args) },
}))
jest.mock("@services/mongoose/utils", () => ({
  parseRepositoryError: (error: unknown) => error,
}))

describe("indexed username candidate search", () => {
  beforeEach(() => find.mockReset())
  it("uses bounded index reads and exposes only public usernames", async () => {
    const reads: Record<string, jest.Mock>[] = []
    find.mockImplementation(() => {
      const query = {
        collation: jest.fn(),
        hint: jest.fn(),
        sort: jest.fn(),
        limit: jest.fn(),
        maxTimeMS: jest.fn(),
        lean: jest.fn(async () => [{ username: "dreadmax", phone: "not-projected" }]),
      }
      for (const method of ["collation", "hint", "sort", "limit", "maxTimeMS"] as const)
        query[method].mockReturnValue(query)
      reads.push(query)
      return query
    })
    expect(await searchUsernameCandidates("dreadma")).toEqual(["dreadmax"])
    expect(find).toHaveBeenCalledTimes(3)
    for (const [filter, projection] of find.mock.calls) {
      expect(filter).toMatchObject({
        username: { $type: "string" },
        npub: { $type: "string" },
        contactEnabled: true,
      })
      expect(filter.$expr).toBeDefined()
      expect(filter.username.$regex).toBeUndefined()
      expect(projection).toEqual({ _id: 0, username: 1 })
    }
    for (const query of reads) {
      expect(query.hint).toHaveBeenCalledWith({ username: 1 })
      expect(query.collation).toHaveBeenCalledWith({ locale: "en", strength: 2 })
      expect(query.maxTimeMS).toHaveBeenCalledWith(250)
      expect(query.limit.mock.calls[0][0]).toBeLessThanOrEqual(100)
    }
  })
  it("does not report a database timeout as an empty directory", async () => {
    const error = new Error("search timed out")
    find.mockImplementation(() => {
      throw error
    })
    expect(await searchUsernameCandidates("dreadma")).toBe(error)
  })
})
