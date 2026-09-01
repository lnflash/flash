import { checkedToConsentLogSubmission } from "@domain/consent-log"
import { ValidationError } from "@domain/shared"

// The /consent/log endpoint takes anonymous, unauthenticated web input. This
// validator is its whole admission gate: everything stored comes through
// here, everything unknown must be discarded, every field must be bounded.

const validBody = () => ({
  version: "FLASH_CONSENT_V2_2025-09-23",
  page: "https://getflash.io/invite/?token=abc",
  userAgent: "Mozilla/5.0",
  timestamp: "2026-09-01T18:00:00.000Z",
  token: "a".repeat(64),
  consents: {
    transactional: { optedIn: true, purpose: "2FA codes", frequency: "as needed" },
    marketing: { optedIn: false, purpose: "offers", frequency: "up to 4/mo" },
  },
})

describe("checkedToConsentLogSubmission", () => {
  it("accepts the shape the invite page actually sends", () => {
    const result = checkedToConsentLogSubmission(validBody())

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) throw result
    expect(result.version).toBe("FLASH_CONSENT_V2_2025-09-23")
    expect(result.consents.transactional.optedIn).toBe(true)
    expect(result.consents.marketing.optedIn).toBe(false)
    // The page's `page` field lands as sourceUrl.
    expect(result.sourceUrl).toBe("https://getflash.io/invite/?token=abc")
  })

  it("discards fields it does not know", () => {
    const body = { ...validBody(), admin: true, $where: "1" }

    const result = checkedToConsentLogSubmission(body)

    if (result instanceof Error) throw result
    expect(Object.keys(result).sort()).toEqual([
      "clientTimestamp",
      "consents",
      "sourceUrl",
      "token",
      "userAgent",
      "version",
    ])
  })

  it.each([
    ["missing version", { version: undefined }],
    ["empty version", { version: "" }],
    ["non-string version", { version: 42 }],
    ["oversized version", { version: "v".repeat(65) }],
    ["missing consents", { consents: undefined }],
    [
      "non-boolean optedIn",
      { consents: { transactional: { optedIn: "yes" }, marketing: { optedIn: false } } },
    ],
    ["missing marketing leg", { consents: { transactional: { optedIn: true } } }],
    ["oversized token", { token: "t".repeat(129) }],
    ["oversized userAgent", { userAgent: "u".repeat(1025) }],
    ["non-string page", { page: { toString: "attack" } }],
  ])("rejects %s", (_label, overrides) => {
    const result = checkedToConsentLogSubmission({ ...validBody(), ...overrides })

    expect(result).toBeInstanceOf(ValidationError)
  })

  it("rejects non-object bodies outright", () => {
    expect(checkedToConsentLogSubmission(null)).toBeInstanceOf(ValidationError)
    expect(checkedToConsentLogSubmission("[]")).toBeInstanceOf(ValidationError)
    expect(checkedToConsentLogSubmission(undefined)).toBeInstanceOf(ValidationError)
  })

  it("accepts a minimal record: version + bare consent booleans", () => {
    const result = checkedToConsentLogSubmission({
      version: "v1",
      consents: {
        transactional: { optedIn: true },
        marketing: { optedIn: false },
      },
    })

    if (result instanceof Error) throw result
    expect(result.token).toBeUndefined()
    expect(result.sourceUrl).toBeUndefined()
  })
})
