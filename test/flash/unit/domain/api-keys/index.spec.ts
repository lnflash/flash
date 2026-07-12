import { createHash } from "crypto"

import {
  API_KEY_PREFIX,
  API_KEY_SCOPES,
  InvalidApiKeyIpConstraintError,
  InvalidApiKeyNameError,
  InvalidApiKeyScopeError,
  checkedToApiKeyIpConstraints,
  checkedToApiKeyName,
  checkedToApiKeyScopes,
  generateApiKey,
  hashApiKeySecret,
} from "@domain/api-keys"

describe("generateApiKey", () => {
  it("produces a key in fk_{keyId}_{secret} format", () => {
    const { keyId, secret, fullKey } = generateApiKey()

    expect(keyId).toMatch(/^[0-9a-f]{8}$/)
    expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(fullKey).toBe(`${API_KEY_PREFIX}_${keyId}_${secret}`)
  })

  it("parses unambiguously by splitting on underscores", () => {
    const { keyId, secret, fullKey } = generateApiKey()

    const [prefix, parsedKeyId, ...rest] = fullKey.split("_")
    expect(prefix).toBe(API_KEY_PREFIX)
    expect(parsedKeyId).toBe(keyId)
    expect(rest.join("_")).toBe(secret)
  })

  it("hashes the secret with SHA-256 and never includes it in the hash", () => {
    const { secret, hashedSecret } = generateApiKey()

    const expected = createHash("sha256").update(secret).digest("hex")
    expect(hashedSecret).toBe(expected)
    expect(hashedSecret).not.toContain(secret)
  })

  it("generates unique keys", () => {
    const a = generateApiKey()
    const b = generateApiKey()

    expect(a.keyId).not.toBe(b.keyId)
    expect(a.secret).not.toBe(b.secret)
  })
})

describe("hashApiKeySecret", () => {
  it("is deterministic and hex-encoded", () => {
    expect(hashApiKeySecret("some-secret")).toBe(hashApiKeySecret("some-secret"))
    expect(hashApiKeySecret("some-secret")).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("checkedToApiKeyName", () => {
  it("accepts valid names", () => {
    expect(checkedToApiKeyName("BTCPay Server")).toBe("BTCPay Server")
    expect(checkedToApiKeyName("ci-bot_01")).toBe("ci-bot_01")
  })

  it("rejects names shorter than 3 characters", () => {
    expect(checkedToApiKeyName("ab")).toBeInstanceOf(InvalidApiKeyNameError)
    expect(checkedToApiKeyName("")).toBeInstanceOf(InvalidApiKeyNameError)
  })

  it("rejects names longer than 50 characters", () => {
    expect(checkedToApiKeyName("a".repeat(51))).toBeInstanceOf(InvalidApiKeyNameError)
  })

  it("rejects names with invalid characters", () => {
    expect(checkedToApiKeyName("bad!name")).toBeInstanceOf(InvalidApiKeyNameError)
    expect(checkedToApiKeyName("nøpe")).toBeInstanceOf(InvalidApiKeyNameError)
  })
})

describe("checkedToApiKeyScopes", () => {
  it("accepts every defined scope", () => {
    expect(checkedToApiKeyScopes([...API_KEY_SCOPES])).toEqual([...API_KEY_SCOPES])
  })

  it("requires at least one scope", () => {
    expect(checkedToApiKeyScopes([])).toBeInstanceOf(InvalidApiKeyScopeError)
  })

  it("rejects unknown scopes", () => {
    expect(checkedToApiKeyScopes(["read:everything"])).toBeInstanceOf(
      InvalidApiKeyScopeError,
    )
    expect(checkedToApiKeyScopes(["read:user", "write"])).toBeInstanceOf(
      InvalidApiKeyScopeError,
    )
  })
})

describe("checkedToApiKeyIpConstraints", () => {
  it("accepts empty constraints", () => {
    expect(checkedToApiKeyIpConstraints([])).toEqual([])
  })

  it("accepts single IPs and CIDR ranges", () => {
    const ips = ["203.0.113.7", "10.0.0.0/8", "2001:db8::1", "2001:db8::/32"]
    expect(checkedToApiKeyIpConstraints(ips)).toEqual(ips)
  })

  it("rejects malformed entries", () => {
    expect(checkedToApiKeyIpConstraints(["999.0.0.1"])).toBeInstanceOf(
      InvalidApiKeyIpConstraintError,
    )
    expect(checkedToApiKeyIpConstraints(["10.0.0.0/33"])).toBeInstanceOf(
      InvalidApiKeyIpConstraintError,
    )
    expect(checkedToApiKeyIpConstraints(["not-an-ip"])).toBeInstanceOf(
      InvalidApiKeyIpConstraintError,
    )
  })
})
