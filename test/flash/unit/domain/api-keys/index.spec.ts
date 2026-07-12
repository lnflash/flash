import { createHash } from "crypto"

import {
  API_KEY_PREFIX,
  API_KEY_RATE_LIMIT_MAX,
  API_KEY_RATE_LIMIT_MIN,
  API_KEY_SCOPES,
  InvalidApiKeyFormatError,
  InvalidApiKeyIpConstraintError,
  InvalidApiKeyNameError,
  InvalidApiKeyRateLimitError,
  InvalidApiKeyScopeError,
  checkedToApiKeyIpConstraints,
  checkedToApiKeyName,
  checkedToApiKeyRateLimit,
  checkedToApiKeyScopes,
  effectiveApiKeyStatus,
  generateApiKey,
  hasApiKeyScope,
  hashApiKeySecret,
  isApiKeySecretValid,
  isApiKeySessionId,
  isIpAllowedByConstraints,
  parseApiKey,
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

describe("parseApiKey", () => {
  it("round-trips generated keys", () => {
    const generated = generateApiKey()

    const parsed = parseApiKey(generated.fullKey)
    if (parsed instanceof Error) throw parsed

    expect(parsed.keyId).toBe(generated.keyId)
    expect(parsed.secret).toBe(generated.secret)
  })

  it("rejects malformed keys", () => {
    const { keyId, secret } = generateApiKey()
    const malformed = [
      "",
      "not-a-key",
      `flash_${keyId}_${secret}`, // wrong prefix
      `fk_${keyId}`, // missing secret
      `fk_${keyId.slice(0, 6)}_${secret}`, // short keyId
      `fk_${keyId.toUpperCase()}_${secret}`, // keyId must be lowercase hex
      `fk_${keyId}_${secret.slice(0, 63)}`, // short secret
      `fk_${keyId}_${secret}x`, // long secret
    ]

    for (const raw of malformed) {
      expect(parseApiKey(raw)).toBeInstanceOf(InvalidApiKeyFormatError)
    }
  })
})

describe("isApiKeySecretValid", () => {
  it("accepts the matching secret and rejects others", () => {
    const { secret, hashedSecret } = generateApiKey()
    const other = generateApiKey()

    expect(isApiKeySecretValid({ secret, hashedKey: hashedSecret })).toBe(true)
    expect(isApiKeySecretValid({ secret: other.secret, hashedKey: hashedSecret })).toBe(
      false,
    )
  })
})

describe("isApiKeySessionId", () => {
  it("detects api-key session ids and nothing else", () => {
    expect(isApiKeySessionId("apikey:8e8b4f60")).toBe(true)
    expect(isApiKeySessionId("fa595e7b-7c7e-485c-be06-d968be32ec64")).toBe(false)
    expect(isApiKeySessionId(undefined)).toBe(false)
    expect(isApiKeySessionId("")).toBe(false)
  })
})

describe("effectiveApiKeyStatus", () => {
  const base = {
    expiresAt: null as Date | null,
    status: "active" as ApiKeyStatus,
  }

  it("reports stored status for non-active keys", () => {
    expect(effectiveApiKeyStatus({ ...base, status: "revoked" } as ApiKey)).toBe(
      "revoked",
    )
  })

  it("reports expired for active keys past their expiry", () => {
    expect(
      effectiveApiKeyStatus({
        ...base,
        expiresAt: new Date(Date.now() - 1000),
      } as ApiKey),
    ).toBe("expired")
    expect(
      effectiveApiKeyStatus({
        ...base,
        expiresAt: new Date(Date.now() + 60_000),
      } as ApiKey),
    ).toBe("active")
    expect(effectiveApiKeyStatus({ ...base } as ApiKey)).toBe("active")
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

describe("checkedToApiKeyRateLimit", () => {
  it("accepts integers within bounds", () => {
    expect(checkedToApiKeyRateLimit(API_KEY_RATE_LIMIT_MIN)).toBe(1)
    expect(checkedToApiKeyRateLimit(120)).toBe(120)
    expect(checkedToApiKeyRateLimit(API_KEY_RATE_LIMIT_MAX)).toBe(10000)
  })

  it("rejects values below 1 and above 10000", () => {
    expect(checkedToApiKeyRateLimit(0)).toBeInstanceOf(InvalidApiKeyRateLimitError)
    expect(checkedToApiKeyRateLimit(-5)).toBeInstanceOf(InvalidApiKeyRateLimitError)
    expect(checkedToApiKeyRateLimit(10001)).toBeInstanceOf(InvalidApiKeyRateLimitError)
  })

  it("rejects non-integer values", () => {
    expect(checkedToApiKeyRateLimit(1.5)).toBeInstanceOf(InvalidApiKeyRateLimitError)
    expect(checkedToApiKeyRateLimit(NaN)).toBeInstanceOf(InvalidApiKeyRateLimitError)
    expect(checkedToApiKeyRateLimit(Infinity)).toBeInstanceOf(InvalidApiKeyRateLimitError)
  })
})

describe("isIpAllowedByConstraints", () => {
  it("allows any IP when constraints are empty", () => {
    expect(isIpAllowedByConstraints({ ip: "203.0.113.7", constraints: [] })).toBe(true)
    expect(isIpAllowedByConstraints({ ip: "garbage", constraints: [] })).toBe(true)
  })

  it("matches an exact IPv4 entry", () => {
    const constraints = ["203.0.113.7"]
    expect(isIpAllowedByConstraints({ ip: "203.0.113.7", constraints })).toBe(true)
    expect(isIpAllowedByConstraints({ ip: "203.0.113.8", constraints })).toBe(false)
  })

  it("matches IPv4 CIDR ranges", () => {
    expect(
      isIpAllowedByConstraints({ ip: "10.20.30.40", constraints: ["10.0.0.0/8"] }),
    ).toBe(true)
    expect(
      isIpAllowedByConstraints({ ip: "11.0.0.1", constraints: ["10.0.0.0/8"] }),
    ).toBe(false)
    expect(
      isIpAllowedByConstraints({ ip: "203.0.113.7", constraints: ["203.0.113.7/32"] }),
    ).toBe(true)
    expect(
      isIpAllowedByConstraints({ ip: "203.0.113.8", constraints: ["203.0.113.7/32"] }),
    ).toBe(false)
  })

  it("matches exact IPv6 and IPv6 CIDR entries", () => {
    expect(
      isIpAllowedByConstraints({ ip: "2001:db8::1", constraints: ["2001:db8::1"] }),
    ).toBe(true)
    expect(
      isIpAllowedByConstraints({
        ip: "2001:0db8:0000:0000:0000:0000:0000:0001",
        constraints: ["2001:db8::1"],
      }),
    ).toBe(true)
    expect(
      isIpAllowedByConstraints({
        ip: "2001:db8:1234::1",
        constraints: ["2001:db8::/32"],
      }),
    ).toBe(true)
    expect(
      isIpAllowedByConstraints({ ip: "2001:db9::1", constraints: ["2001:db8::/32"] }),
    ).toBe(false)
  })

  it("normalizes IPv4-mapped IPv6 client addresses", () => {
    expect(
      isIpAllowedByConstraints({ ip: "::ffff:10.0.0.1", constraints: ["10.0.0.0/8"] }),
    ).toBe(true)
    expect(
      isIpAllowedByConstraints({
        ip: "::ffff:203.0.113.7",
        constraints: ["203.0.113.7"],
      }),
    ).toBe(true)
  })

  it("never matches across address families", () => {
    expect(
      isIpAllowedByConstraints({ ip: "10.0.0.1", constraints: ["2001:db8::/32"] }),
    ).toBe(false)
    expect(
      isIpAllowedByConstraints({ ip: "2001:db8::1", constraints: ["10.0.0.0/8"] }),
    ).toBe(false)
  })

  it("returns false for a garbage ip instead of throwing", () => {
    expect(
      isIpAllowedByConstraints({ ip: "not-an-ip", constraints: ["10.0.0.0/8"] }),
    ).toBe(false)
    expect(isIpAllowedByConstraints({ ip: "", constraints: ["10.0.0.0/8"] })).toBe(false)
  })

  it("skips malformed constraint entries without throwing", () => {
    expect(
      isIpAllowedByConstraints({
        ip: "10.0.0.1",
        constraints: ["not-an-ip", "999.0.0.0/8", "10.0.0.1"],
      }),
    ).toBe(true)
    expect(isIpAllowedByConstraints({ ip: "10.0.0.1", constraints: ["not-an-ip"] })).toBe(
      false,
    )
  })
})

describe("hasApiKeyScope", () => {
  it("grants nothing on empty scopes", () => {
    for (const required of API_KEY_SCOPES) {
      expect(hasApiKeyScope({ grantedScopes: [], required })).toBe(false)
    }
  })

  it("grants an exact scope match", () => {
    expect(hasApiKeyScope({ grantedScopes: ["read:user"], required: "read:user" })).toBe(
      true,
    )
    expect(
      hasApiKeyScope({ grantedScopes: ["write:wallet"], required: "write:wallet" }),
    ).toBe(true)
  })

  it("write implies read for the same resource", () => {
    expect(
      hasApiKeyScope({ grantedScopes: ["write:wallet"], required: "read:wallet" }),
    ).toBe(true)
    expect(hasApiKeyScope({ grantedScopes: ["write:user"], required: "read:user" })).toBe(
      true,
    )
    expect(
      hasApiKeyScope({
        grantedScopes: ["write:transactions"],
        required: "read:transactions",
      }),
    ).toBe(true)
  })

  it("read does not imply write", () => {
    expect(
      hasApiKeyScope({ grantedScopes: ["read:wallet"], required: "write:wallet" }),
    ).toBe(false)
  })

  it("does not grant across resources", () => {
    expect(
      hasApiKeyScope({ grantedScopes: ["write:wallet"], required: "read:user" }),
    ).toBe(false)
    expect(
      hasApiKeyScope({
        grantedScopes: ["read:wallet", "read:user"],
        required: "read:transactions",
      }),
    ).toBe(false)
  })

  it("admin grants every scope", () => {
    for (const required of API_KEY_SCOPES) {
      expect(hasApiKeyScope({ grantedScopes: ["admin"], required })).toBe(true)
    }
  })
})
