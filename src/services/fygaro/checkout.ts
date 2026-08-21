import { createHmac } from "crypto"

/**
 * Fygaro Links supports two ways of handing a payment to their hosted checkout
 * (https://help.fygaro.com/en-us/article/fygaro-links-integration-api-h78p9y/):
 *
 *   pre-fill  `[button]?amount=…&custom_reference=…`  — customer CAN edit
 *   jwt       `[button]?jwt=<token>`                  — cryptographically locked
 *
 * The app has always built the pre-fill URL on the device, which makes both the
 * amount and — more importantly — `custom_reference` user-controlled. That
 * reference is the credit key: it decides whose wallet the payment lands in.
 * So neither the amount nor the destination was ever authenticated, and any
 * client-side limit was advisory.
 *
 * This module mints the signed alternative. Nothing here talks to Fygaro: the
 * token is an HMAC over values we choose, using the same shared secret the
 * webhook already verifies inbound calls with, so there is no outbound call and
 * no new failure mode at request time.
 */

// Separates the username from the server-issued intent id inside
// `custom_reference`. Chosen because usernames cannot contain it (see
// checkedToUsername) and it survives URL/JSON encoding unescaped.
export const FYGARO_REFERENCE_SEPARATOR = "|"

/**
 * Fygaro's hard limit on `custom_reference`. Exceeding it is not a soft
 * truncation — Fygaro refuses the whole checkout with "Custom reference cannot
 * exceed 40 characters in length", which the customer meets as an error page
 * where the payment form should be.
 *
 * This is why signed checkout never worked for a single real account. The
 * original format was `<username>|<uuid>`: a v4 UUID is 36 characters and the
 * separator is 1, so the reference was 37 + the username, and usernames are at
 * least 3 characters (UsernameRegex). Exactly 40 for a 3-character username and
 * over the limit for every longer one — which is to say, everyone.
 */
export const FYGARO_CUSTOM_REFERENCE_MAX_LENGTH = 40

export type FygaroCustomReference = {
  // Absent when the reference carries ONLY an intent id — see
  // buildCustomReference for when that happens. The caller resolves the account
  // from the intent record in that case.
  username?: string
  // Absent for references built by app versions that predate signed checkout.
  // Those payments are still recorded and still pass through the credit gate —
  // they simply carry no proof of what was authorised.
  intentId?: string
}

/**
 * `<username>|<intentId>`, or bare `<username>` when no intent is bound.
 *
 * When the username is long enough that `<username>|<intentId>` would breach
 * Fygaro's 40-character ceiling, the username is dropped and the reference
 * becomes `|<intentId>` — a leading separator, which is unambiguous because a
 * username can never be empty and can never contain the separator.
 *
 * Keeping the username whenever it FITS is deliberate, and it is the reason
 * this is a conditional rather than always minting the short form. The username
 * is what the webhook attributes a payment by; the intent record is a 75-minute
 * Redis entry. If Redis is lost mid-window, `<username>|<intentId>` still names
 * an account and the payment credits, where `|<intentId>` alone would fall
 * through to payer-email attribution. That fallback exists and is handled, but
 * it is strictly worse than not needing it, so it is reserved for the case that
 * has no alternative.
 */
export const buildCustomReference = ({
  username,
  intentId,
}: {
  username: string
  intentId?: string
}): string => {
  if (!intentId) return username
  const withUsername = `${username}${FYGARO_REFERENCE_SEPARATOR}${intentId}`
  // Measured in UTF-8 BYTES, not `String.length`. Fygaro documents the cap as
  // "40 characters" but does not say what it counts, and UsernameRegex is
  // `[\p{L}0-9_]{3,50}` — ANY Unicode letter — so a 13-character Cyrillic
  // username is 26 UTF-16 code units and 39 UTF-8 bytes. If their validator
  // counts bytes, `.length` would hand that account a reference Fygaro
  // refuses: an error page where the payment form should be, then a silent
  // fall back to the editable legacy URL. That is precisely the bug this
  // module exists to fix, and assuming the unit of the limit is the same
  // mistake one level down. Bytes is the conservative reading — the only cost
  // of being wrong this way is that a few more accounts take the `|<intentId>`
  // form, which is handled end to end.
  if (Buffer.byteLength(withUsername, "utf8") <= FYGARO_CUSTOM_REFERENCE_MAX_LENGTH) {
    return withUsername
  }
  return `${FYGARO_REFERENCE_SEPARATOR}${intentId}`
}

/**
 * Read a `custom_reference` coming back from Fygaro.
 *
 * Deliberately lenient about shape and strict about meaning: anything that is
 * not exactly `username|intentId` yields no intentId, so the caller falls back
 * to the unverified legacy path rather than treating a malformed reference as
 * an authorisation. Returns undefined only when there is no usable username at
 * all — that is the "payment we cannot attribute" case the webhook already
 * records and alerts on.
 */
export const parseCustomReference = (
  raw: string | undefined | null,
): FygaroCustomReference | undefined => {
  const trimmed = (raw ?? "").trim()
  if (trimmed === "") return undefined

  const parts = trimmed.split(FYGARO_REFERENCE_SEPARATOR)
  const username = parts[0].trim()

  // Exactly two segments is the only shape that carries an intent. A third
  // means something built a reference we do not understand; treating that as
  // legacy is the safe reading.
  if (parts.length !== 2) return username === "" ? undefined : { username }
  const intentId = parts[1].trim()

  // `|<intentId>` — the long-username form. An empty first segment cannot be a
  // username (they are 3+ characters), so this shape is unambiguous. The caller
  // resolves the account from the intent record.
  if (username === "") return intentId === "" ? undefined : { intentId }

  if (intentId === "") return { username }
  return { username, intentId }
}

const base64Url = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

/**
 * Fygaro renders the amount as given, so it must be a plain 2-decimal string:
 * "80" or "80.5" are not acceptable where "80.00" and "80.50" are.
 */
export const formatFygaroAmount = (amountCents: number): string =>
  (amountCents / 100).toFixed(2)

export type FygaroCheckoutJwtPayload = {
  amount: string
  currency: string
  custom_reference: string
  // Seconds since epoch. `exp` bounds replay: a URL captured from the WebView
  // cannot be paid tomorrow, when the rolling-24h allowance has moved on.
  exp: number
  nbf: number
}

/**
 * How far `nbf` is backdated.
 *
 * Fygaro validates the token against THEIR clock. `nbf: now` with zero leeway
 * means a server running even a second fast mints a link that is "not yet
 * valid" — a dead end at the payment page, which is a payer-facing hard failure
 * rather than a degraded credit. Flash already tolerates 5 minutes of skew on
 * the inbound webhook (`webhook.timestampSkewMs`); the outbound side has no
 * business being stricter. `exp` is what actually bounds replay.
 */
export const NBF_SKEW_SECONDS = 60

/**
 * Sign a Fygaro checkout payload. HS256 over the shared secret, with the key id
 * in the header so Fygaro knows which secret to verify against — the same
 * key-id/secret pairing the inbound webhook already uses, which is why secret
 * rotation needs no change here.
 */
export const signFygaroCheckoutJwt = ({
  payload,
  keyId,
  secret,
}: {
  payload: FygaroCheckoutJwtPayload
  keyId: string
  secret: string
}): string => {
  const header = { alg: "HS256", typ: "JWT", kid: keyId }
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(payload),
  )}`
  const signature = base64Url(createHmac("sha256", secret).update(signingInput).digest())
  return `${signingInput}.${signature}`
}

export type FygaroCheckout = {
  url: string
  expiresAt: Date
  customReference: string
  // Handed to the client so it can ask what became of the payment instead of
  // assuming. It is already inside the token in the URL, so returning it
  // exposes nothing new — it just stops the app having to parse its own link.
  intentId: string
}

/**
 * Build the locked checkout URL for one authorised top-up.
 *
 * `nowMs` is injected so the caller (and tests) control the validity window
 * rather than inheriting wall-clock behaviour.
 */
export const buildFygaroCheckout = ({
  buttonUrl,
  username,
  intentId,
  amountCents,
  currency,
  keyId,
  secret,
  ttlSeconds,
  nowMs,
}: {
  buttonUrl: string
  username: string
  intentId: string
  amountCents: number
  currency: string
  keyId: string
  secret: string
  ttlSeconds: number
  nowMs: number
}): FygaroCheckout => {
  const nowSecs = Math.floor(nowMs / 1000)
  const customReference = buildCustomReference({ username, intentId })
  const payload: FygaroCheckoutJwtPayload = {
    amount: formatFygaroAmount(amountCents),
    currency,
    custom_reference: customReference,
    nbf: nowSecs - NBF_SKEW_SECONDS,
    exp: nowSecs + ttlSeconds,
  }

  const token = signFygaroCheckoutJwt({ payload, keyId, secret })
  // The token carries every payment parameter, so nothing else is appended:
  // an `amount` query param alongside it would be exactly the editable value
  // this change exists to remove.
  const separator = buttonUrl.includes("?") ? "&" : "?"

  return {
    url: `${buttonUrl}${separator}jwt=${token}`,
    expiresAt: new Date((nowSecs + ttlSeconds) * 1000),
    customReference,
    intentId,
  }
}
