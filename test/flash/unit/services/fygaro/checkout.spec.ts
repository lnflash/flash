import { createHmac } from "crypto"

import {
  buildCustomReference,
  FYGARO_CUSTOM_REFERENCE_MAX_LENGTH,
  buildFygaroCheckout,
  formatFygaroAmount,
  NBF_SKEW_SECONDS,
  parseCustomReference,
  signFygaroCheckoutJwt,
} from "@services/fygaro/checkout"
import { newIntentId } from "@services/fygaro/checkout-intent-store"

const SECRET = "fygaro-shared-secret"
const KEY_ID = "key-1"
const BUTTON = "https://fygaro.com/en/pb/ABC123"

const decodeSegment = (seg: string) =>
  JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString())

describe("formatFygaroAmount", () => {
  it("always renders two decimals", () => {
    // Fygaro renders the string as-is; "80" or "80.5" are not valid amounts.
    expect(formatFygaroAmount(8000)).toBe("80.00")
    expect(formatFygaroAmount(8050)).toBe("80.50")
    expect(formatFygaroAmount(7552)).toBe("75.52")
    expect(formatFygaroAmount(1)).toBe("0.01")
  })
})

describe("custom_reference round-trip", () => {
  it("carries the intent id when there is one", () => {
    expect(buildCustomReference({ username: "jaceth2009", intentId: "abc-123" })).toBe(
      "jaceth2009|abc-123",
    )
    expect(parseCustomReference("jaceth2009|abc-123")).toEqual({
      username: "jaceth2009",
      intentId: "abc-123",
    })
  })

  it("never mints a reference Fygaro will refuse", () => {
    // THE BUG. Fygaro caps custom_reference at 40 characters and refuses the
    // whole checkout past it — the customer gets "Custom reference cannot
    // exceed 40 characters in length" where the payment form should be.
    //
    // The original format was `<username>|<uuid>`: 36 + 1 + username, so it was
    // exactly 40 for a 3-character username (the shortest one allowed) and over
    // for every longer one. Signed checkout could never have worked for a real
    // account, which is why the amount stayed editable for everyone — the app
    // was falling back to the legacy URL every time.
    //
    // The non-ASCII entries are not decoration. UsernameRegex is
    // `[\p{L}0-9_]{3,50}` — any Unicode letter — so a username of ordinary
    // LENGTH can be well past 40 BYTES, and Fygaro documents the cap as
    // "characters" without saying what it counts. The ceiling is therefore
    // measured in UTF-8 bytes, and these pin that: 13 Cyrillic characters is
    // 26 UTF-8 bytes, so `<username>|<16-char id>` is 43 bytes — over the cap
    // on a reference that is only 30 characters long.
    for (const username of [
      "abc",
      "jaceth2009",
      "a".repeat(23),
      "a".repeat(50),
      "марианна",
      "з".repeat(13),
      "日本語のなまえ",
    ]) {
      const reference = buildCustomReference({ username, intentId: newIntentId() })
      expect(Buffer.byteLength(reference, "utf8")).toBeLessThanOrEqual(
        FYGARO_CUSTOM_REFERENCE_MAX_LENGTH,
      )
    }
  })

  it("keeps the username inline whenever it fits, and drops it only when it cannot", () => {
    // Keeping the username is what lets the webhook attribute a payment without
    // Redis. The intent record is a 75-minute entry; if it is lost mid-window,
    // an inline username still credits the right account, where `|<intentId>`
    // alone falls through to payer-email attribution. So the short form is a
    // last resort, not the default.
    const id = newIntentId()
    expect(buildCustomReference({ username: "jaceth2009", intentId: id })).toBe(
      `jaceth2009|${id}`,
    )

    // 23 characters is the longest username that still fits alongside a
    // 16-character id and the separator.
    const longest = "a".repeat(23)
    expect(buildCustomReference({ username: longest, intentId: id })).toBe(
      `${longest}|${id}`,
    )

    const tooLong = "a".repeat(24)
    expect(buildCustomReference({ username: tooLong, intentId: id })).toBe(`|${id}`)
    expect(parseCustomReference(`|${id}`)).toEqual({ intentId: id })
  })

  it("mints an intent id short enough to leave room for a username", () => {
    // 12 random bytes as base64url: 16 characters, no padding to strip.
    const id = newIntentId()
    expect(id).toHaveLength(16)
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it("draws the id from 12 random bytes — 96 bits, not a shorter draw", () => {
    // Assert on the WIDTH OF THE DRAW, not on a sample of outputs. The
    // previous assertion here was `new Set(200 draws).size === 200`, which
    // cannot tell 96 bits from 32: narrowing randomBytes(12) to randomBytes(4)
    // collides with probability ~2e-5 over 200 draws, so that test passes
    // essentially always on the one regression it exists to catch. Decoding
    // the id back to bytes catches it on the first draw.
    expect(Buffer.from(newIntentId(), "base64url")).toHaveLength(12)
  })

  it("reads a bare username as legacy, with no intent", () => {
    // Every app version before signed checkout sends this shape, and will keep
    // sending it for months. It must stay attributable.
    expect(buildCustomReference({ username: "jaceth2009" })).toBe("jaceth2009")
    expect(parseCustomReference("jaceth2009")).toEqual({ username: "jaceth2009" })
  })

  it("never invents an intent from a malformed reference", () => {
    // A reference we do not understand must degrade to legacy, never to a
    // claim that the server authorised something.
    for (const raw of [
      "jaceth2009|",
      "jaceth2009|   ",
      "jaceth2009|a|b",
      "jaceth2009||abc",
    ]) {
      expect(parseCustomReference(raw)?.intentId).toBeUndefined()
      expect(parseCustomReference(raw)?.username).toBe("jaceth2009")
    }
  })

  it("returns undefined when there is nothing usable at all", () => {
    for (const raw of ["", "   ", "|", " | ", undefined, null]) {
      expect(parseCustomReference(raw)).toBeUndefined()
    }
  })

  it("reads a leading separator as an intent with no username", () => {
    // The long-username form. `<username>|<intentId>` breaches Fygaro's
    // 40-character ceiling once the username is more than 23 characters, so
    // buildCustomReference drops the username and mints `|<intentId>`. An empty
    // first segment cannot be a username — they are 3+ characters — so this
    // shape is unambiguous, and the webhook recovers the account from the
    // intent record.
    expect(parseCustomReference("|abc-123")).toEqual({ intentId: "abc-123" })
    expect(parseCustomReference("  |  abc-123 ")).toEqual({ intentId: "abc-123" })
  })

  it("trims surrounding whitespace on both halves", () => {
    expect(parseCustomReference("  jaceth2009 | abc-123  ")).toEqual({
      username: "jaceth2009",
      intentId: "abc-123",
    })
  })
})

describe("signFygaroCheckoutJwt", () => {
  const payload = {
    amount: "80.00",
    currency: "USD",
    custom_reference: "jaceth2009|abc-123",
    nbf: 1_700_000_000,
    exp: 1_700_000_900,
  }

  it("emits the header shape Fygaro documents, including kid", () => {
    const [header] = signFygaroCheckoutJwt({
      payload,
      keyId: KEY_ID,
      secret: SECRET,
    }).split(".")
    expect(decodeSegment(header)).toEqual({ alg: "HS256", typ: "JWT", kid: KEY_ID })
  })

  it("signs HS256 over base64url(header).base64url(payload)", () => {
    const token = signFygaroCheckoutJwt({ payload, keyId: KEY_ID, secret: SECRET })
    const [h, p, sig] = token.split(".")
    const expected = createHmac("sha256", SECRET)
      .update(`${h}.${p}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(sig).toBe(expected)
  })

  it("produces base64url with no padding — a padded token is rejected as malformed", () => {
    const token = signFygaroCheckoutJwt({ payload, keyId: KEY_ID, secret: SECRET })
    expect(token).not.toContain("=")
    expect(token).not.toContain("+")
    expect(token).not.toContain("/")
    expect(token.split(".")).toHaveLength(3)
  })

  it("changes signature when the amount changes — the whole point", () => {
    const a = signFygaroCheckoutJwt({ payload, keyId: KEY_ID, secret: SECRET })
    const b = signFygaroCheckoutJwt({
      payload: { ...payload, amount: "800.00" },
      keyId: KEY_ID,
      secret: SECRET,
    })
    expect(a).not.toBe(b)
  })

  it("changes signature when custom_reference changes", () => {
    // custom_reference decides whose wallet is credited; it must be as
    // tamper-evident as the amount.
    const a = signFygaroCheckoutJwt({ payload, keyId: KEY_ID, secret: SECRET })
    const b = signFygaroCheckoutJwt({
      payload: { ...payload, custom_reference: "someone-else|abc-123" },
      keyId: KEY_ID,
      secret: SECRET,
    })
    expect(a).not.toBe(b)
  })

  it("cannot be re-signed with the wrong secret", () => {
    const a = signFygaroCheckoutJwt({ payload, keyId: KEY_ID, secret: SECRET })
    const b = signFygaroCheckoutJwt({ payload, keyId: KEY_ID, secret: "other-secret" })
    expect(a).not.toBe(b)
  })
})

describe("buildFygaroCheckout", () => {
  const args = {
    buttonUrl: BUTTON,
    username: "jaceth2009",
    intentId: "abc-123",
    amountCents: 8000,
    currency: "USD",
    keyId: KEY_ID,
    secret: SECRET,
    ttlSeconds: 900,
    nowMs: 1_700_000_000_000,
  }

  it("puts every payment parameter inside the token and none in the query", () => {
    // An `amount=` alongside the jwt would reintroduce the editable value this
    // change exists to remove.
    const { url } = buildFygaroCheckout(args)
    expect(url.startsWith(`${BUTTON}?jwt=`)).toBe(true)
    expect(url).not.toContain("amount=")
    expect(url).not.toContain("custom_reference=")

    const payload = decodeSegment(url.split("?jwt=")[1].split(".")[1])
    expect(payload).toEqual({
      amount: "80.00",
      currency: "USD",
      custom_reference: "jaceth2009|abc-123",
      nbf: 1_700_000_000 - NBF_SKEW_SECONDS,
      exp: 1_700_000_900,
    })
  })

  it("backdates nbf so a clock a few seconds ahead does not dead-end the payer", () => {
    // Fygaro validates the token against THEIR clock. `nbf: now` with zero
    // leeway means a server running slightly fast mints a link Fygaro rejects
    // as "not yet valid" — the customer hits a dead end at the payment page.
    // Flash already tolerates 5 minutes of skew inbound; outbound must not be
    // stricter. `exp` is what bounds replay, not `nbf`.
    const payload = decodeSegment(
      buildFygaroCheckout(args).url.split("?jwt=")[1].split(".")[1],
    )
    expect(NBF_SKEW_SECONDS).toBeGreaterThan(0)
    expect(payload.nbf).toBeLessThan(Math.floor(args.nowMs / 1000))
    expect(payload.nbf).toBe(Math.floor(args.nowMs / 1000) - NBF_SKEW_SECONDS)
  })

  it("bounds the validity window so a captured URL cannot be paid later", () => {
    const { expiresAt } = buildFygaroCheckout(args)
    expect(expiresAt.getTime()).toBe(1_700_000_900_000)
  })

  it("appends with & when the button URL already has a query string", () => {
    const { url } = buildFygaroCheckout({ ...args, buttonUrl: `${BUTTON}?lang=en` })
    expect(url).toContain("?lang=en&jwt=")
  })

  it("returns the reference it signed, so the intent is stored under the same value", () => {
    const { customReference } = buildFygaroCheckout(args)
    expect(customReference).toBe("jaceth2009|abc-123")
    expect(parseCustomReference(customReference)).toEqual({
      username: "jaceth2009",
      intentId: "abc-123",
    })
  })
})
