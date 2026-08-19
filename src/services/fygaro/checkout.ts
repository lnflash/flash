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

export type FygaroCustomReference = {
  username: string
  // Absent for references built by app versions that predate signed checkout.
  // Those payments are still recorded and still pass through the credit gate —
  // they simply carry no proof of what was authorised.
  intentId?: string
}

/**
 * `<username>|<intentId>`, or bare `<username>` when no intent is bound.
 */
export const buildCustomReference = ({
  username,
  intentId,
}: {
  username: string
  intentId?: string
}): string =>
  intentId ? `${username}${FYGARO_REFERENCE_SEPARATOR}${intentId}` : username

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
  if (username === "") return undefined

  // Exactly two segments, both non-empty, is the only shape that carries an
  // intent. A third segment means something built a reference we do not
  // understand; treating that as legacy is the safe reading.
  if (parts.length !== 2) return { username }
  const intentId = parts[1].trim()
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
