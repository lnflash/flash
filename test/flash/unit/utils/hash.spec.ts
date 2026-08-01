import { sha256, generateSecureToken, hashToken, generateInviteToken } from "@utils"

describe("sha256", () => {
  it("matches known vectors", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  it("is deterministic", () => {
    expect(sha256("flash")).toBe(sha256("flash"))
  })

  it("produces different digests for different inputs", () => {
    expect(sha256("a")).not.toBe(sha256("b"))
  })

  it("returns 64 hex characters", () => {
    expect(sha256("anything")).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("generateSecureToken", () => {
  it("defaults to 20 bytes (40 hex chars)", () => {
    expect(generateSecureToken()).toMatch(/^[a-f0-9]{40}$/)
  })

  it("honours a custom byte length", () => {
    expect(generateSecureToken(32)).toMatch(/^[a-f0-9]{64}$/)
  })

  it("is effectively random across calls", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateSecureToken()))
    expect(tokens.size).toBe(100)
  })
})

describe("hashToken", () => {
  it("is sha256 of the token", () => {
    const token = "deadbeef"
    expect(hashToken(token)).toBe(sha256(token))
  })
})

describe("generateInviteToken", () => {
  it("returns a 40-hex token and its sha256 hash", () => {
    const { token, tokenHash } = generateInviteToken()
    expect(token).toMatch(/^[a-f0-9]{40}$/)
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(tokenHash).toBe(sha256(token))
  })

  it("produces a unique token each call", () => {
    expect(generateInviteToken().token).not.toBe(generateInviteToken().token)
  })
})
