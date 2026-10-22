import {
  normalizeUsernameSearch,
  rankUsernameSearch,
  usernameSearchVariants,
} from "@domain/accounts/username-search"

describe("public username search", () => {
  it.each([
    [" @Dread Max ", "dreadmax"],
    ["maria s", "marias"],
    ["maria_s", "maria_s"],
    ["josé", "josé"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeUsernameSearch(input)).toBe(expected)
  })
  it.each([
    "",
    "ab",
    "dre*",
    "dre.*",
    "$where",
    "person@elsewhere.com",
    "a".repeat(51),
    " ".repeat(81),
  ])("refuses %s without constructing a broad database query", (input) => {
    expect(normalizeUsernameSearch(input)).toBeUndefined()
  })
  it("finds public names beyond a contact list through prefix and spelling candidates", () => {
    const candidates = usernameSearchVariants("dreadma")
    expect(candidates).toContain("dreadmax")
    expect(usernameSearchVariants("treadmax")).toContain("dreadmax")
    expect(usernameSearchVariants("dreadmxa")).toContain("dreadmax")
    expect(rankUsernameSearch("dreadma", ["alice", "dreadmax", "dreadmark"])).toEqual([
      "dreadmax",
      "dreadmark",
    ])
    expect(rankUsernameSearch("dreadmarks", ["alice", "dreadmax"])).toEqual(["dreadmax"])
    expect(rankUsernameSearch("marias", ["maria_s", "bob"])).toEqual(["maria_s"])
  })
  it("returns no unrelated contacts for a severe transcription error", () => {
    expect(rankUsernameSearch("flashbacks", ["dreadmax", "alice", "bob"])).toEqual([])
  })
  it("caps results and equality probes for the longest accepted username", () => {
    const variants = usernameSearchVariants("a".repeat(50))
    expect(variants.length).toBeLessThanOrEqual(4000)
    expect(variants.every((name) => name.length >= 3 && name.length <= 50)).toBe(true)
    expect(
      rankUsernameSearch(
        "dread",
        Array.from({ length: 20 }, (_, i) => `dread${i}`),
      ),
    ).toHaveLength(5)
  })
})
