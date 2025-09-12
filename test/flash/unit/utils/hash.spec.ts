import { sha256, generateSecureToken, hashToken, generateInviteToken } from "@utils/hash"

describe("Hash Utilities", () => {
  describe("sha256", () => {
    it("should generate consistent SHA256 hash", () => {
      const input = "test-data"
      const hash1 = sha256(input)
      const hash2 = sha256(input)
      
      expect(hash1).toBe(hash2)
      expect(hash1).toHaveLength(64) // SHA256 produces 64 hex characters
      expect(hash1).toMatch(/^[a-f0-9]{64}$/)
    })

    it("should generate different hashes for different inputs", () => {
      const hash1 = sha256("input1")
      const hash2 = sha256("input2")
      
      expect(hash1).not.toBe(hash2)
    })
  })

  describe("generateSecureToken", () => {
    it("should generate token of specified byte length", () => {
      const token20 = generateSecureToken(20)
      const token32 = generateSecureToken(32)
      
      expect(token20).toHaveLength(40) // 20 bytes = 40 hex characters
      expect(token32).toHaveLength(64) // 32 bytes = 64 hex characters
    })

    it("should generate unique tokens", () => {
      const tokens = new Set<string>()
      for (let i = 0; i < 100; i++) {
        tokens.add(generateSecureToken(20))
      }
      
      expect(tokens.size).toBe(100) // All tokens should be unique
    })

    it("should use default 20 bytes when no parameter provided", () => {
      const token = generateSecureToken()
      expect(token).toHaveLength(40)
    })
  })

  describe("hashToken", () => {
    it("should hash token consistently", () => {
      const token = "test-token-123"
      const hash1 = hashToken(token)
      const hash2 = hashToken(token)
      
      expect(hash1).toBe(hash2)
      expect(hash1).toHaveLength(64)
    })
  })

  describe("generateInviteToken", () => {
    it("should generate token and its hash", () => {
      const { token, tokenHash } = generateInviteToken()
      
      expect(token).toHaveLength(40) // 20 bytes = 40 hex characters
      expect(tokenHash).toHaveLength(64) // SHA256 hash
      expect(tokenHash).toBe(hashToken(token))
    })

    it("should generate unique tokens and hashes", () => {
      const results: { token: string; tokenHash: string }[] = []
      for (let i = 0; i < 10; i++) {
        results.push(generateInviteToken())
      }
      
      const tokens = results.map(r => r.token)
      const hashes = results.map(r => r.tokenHash)
      
      expect(new Set(tokens).size).toBe(10)
      expect(new Set(hashes).size).toBe(10)
    })

    it("should verify hash matches token", () => {
      const { token, tokenHash } = generateInviteToken()
      const verifyHash = hashToken(token)
      
      expect(tokenHash).toBe(verifyHash)
    })
  })
})