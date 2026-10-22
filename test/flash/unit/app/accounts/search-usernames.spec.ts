import { searchUsernames } from "@app/accounts/search-usernames"
const candidates = jest.fn()
jest.mock("@services/mongoose/username-search", () => ({
  searchUsernameCandidates: (...args: unknown[]) => candidates(...args),
}))

describe("username directory", () => {
  beforeEach(() => candidates.mockReset())
  it("returns similar strangers without requiring any contacts", async () => {
    candidates.mockResolvedValue(["bob", "dreadmax", "dreadmark"])
    expect(await searchUsernames("Dread ma")).toEqual(["dreadmax", "dreadmark"])
    expect(candidates).toHaveBeenCalledWith("dreadma")
  })
  it("does not query for wildcard or short input", async () => {
    expect(await searchUsernames(".*")).toBeInstanceOf(Error)
    expect(candidates).not.toHaveBeenCalled()
  })
  it("preserves an unavailable directory as an error", async () => {
    const error = new Error("unavailable")
    candidates.mockResolvedValue(error)
    expect(await searchUsernames("dreadma")).toBe(error)
  })
})
