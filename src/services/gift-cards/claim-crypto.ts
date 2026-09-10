import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto"

import { GiftCardsConfig } from "@config"

import { GiftCardClaimCryptoError } from "@domain/gift-cards"

/**
 * At-rest encryption for gift card claim data (codes, claim links, barcodes).
 *
 * AES-256-GCM. Ciphertext layout, base64-encoded:
 *
 *   version (1 byte, 0x01) | iv (12) | authTag (16) | data
 *
 * `keyId` is the first 16 hex chars of sha256(rawKeyBytes) and is stored next
 * to every ciphertext so a future multi-key map can pick the right key during
 * rotation. Today there is exactly one key; a mismatch is reported, never
 * guessed around.
 *
 * Config is read at call time so tests can mock `@config`. Error messages are
 * fixed strings: no plaintext, no key bytes, no driver text.
 */

const VERSION = 0x01
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const KEY_ID_LENGTH = 16
const ALGORITHM = "aes-256-gcm"

const HEX_KEY = /^[0-9a-fA-F]{64}$/
const BASE64_KEY = /^[A-Za-z0-9+/]+={0,2}$/

const loadKey = (): Buffer | GiftCardClaimCryptoError => {
  const raw = GiftCardsConfig?.claimDataEncryptionKey
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return new GiftCardClaimCryptoError(
      "Gift card claim encryption key is not configured",
    )
  }
  const value = raw.trim()

  if (HEX_KEY.test(value)) return Buffer.from(value, "hex")

  if (BASE64_KEY.test(value)) {
    const decoded = Buffer.from(value, "base64")
    if (decoded.length === KEY_LENGTH) return decoded
  }

  return new GiftCardClaimCryptoError(
    "Gift card claim encryption key must be 32 bytes (64 hex chars or base64)",
  )
}

const keyIdFor = (key: Buffer): string =>
  createHash("sha256").update(key).digest("hex").slice(0, KEY_ID_LENGTH)

const isClaimCode = (value: unknown): value is GiftCardClaimCode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as GiftCardClaimCode).value === "string" &&
  ((value as GiftCardClaimCode).label === null ||
    typeof (value as GiftCardClaimCode).label === "string")

const isBarcode = (value: unknown): value is GiftCardBarcode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as GiftCardBarcode).chars === "string" &&
  typeof (value as GiftCardBarcode).type === "string"

const parseClaim = (value: unknown): GiftCardClaim | null => {
  if (typeof value !== "object" || value === null) return null
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.codes) || !candidate.codes.every(isClaimCode)) return null
  if (candidate.claimLink !== null && typeof candidate.claimLink !== "string") return null
  if (candidate.barcode !== null && !isBarcode(candidate.barcode)) return null
  return {
    codes: candidate.codes.map((code) => ({ label: code.label, value: code.value })),
    claimLink: candidate.claimLink,
    barcode: candidate.barcode
      ? { chars: candidate.barcode.chars, type: candidate.barcode.type }
      : null,
  }
}

/** Id of the key currently configured; stored on the order at fulfilment time. */
export const giftCardClaimKeyId = (): string | GiftCardClaimCryptoError => {
  const key = loadKey()
  if (key instanceof Error) return key
  return keyIdFor(key)
}

export const encryptGiftCardClaim = (
  claim: GiftCardClaim,
): { ciphertext: string; keyId: string } | GiftCardClaimCryptoError => {
  const key = loadKey()
  if (key instanceof Error) return key

  try {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
    cipher.setAAD(Buffer.from([VERSION]))
    const plaintext = Buffer.from(JSON.stringify(claim), "utf8")
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const authTag = cipher.getAuthTag()
    const ciphertext = Buffer.concat([
      Buffer.from([VERSION]),
      iv,
      authTag,
      data,
    ]).toString("base64")
    return { ciphertext, keyId: keyIdFor(key) }
  } catch {
    return new GiftCardClaimCryptoError("Could not encrypt gift card details")
  }
}

export const decryptGiftCardClaim = ({
  ciphertext,
  keyId,
}: {
  ciphertext: string
  keyId: string
}): GiftCardClaim | GiftCardClaimCryptoError => {
  const key = loadKey()
  if (key instanceof Error) return key

  if (keyId !== keyIdFor(key)) {
    return new GiftCardClaimCryptoError("key rotated")
  }

  let packed: Buffer
  try {
    packed = Buffer.from(ciphertext, "base64")
  } catch {
    return new GiftCardClaimCryptoError("Gift card claim ciphertext is malformed")
  }
  if (packed.length < 1 + IV_LENGTH + TAG_LENGTH) {
    return new GiftCardClaimCryptoError("Gift card claim ciphertext is malformed")
  }
  if (packed[0] !== VERSION) {
    return new GiftCardClaimCryptoError("Unsupported gift card claim ciphertext version")
  }

  const iv = packed.subarray(1, 1 + IV_LENGTH)
  const authTag = packed.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH)
  const data = packed.subarray(1 + IV_LENGTH + TAG_LENGTH)

  let plaintext: string
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
    decipher.setAAD(Buffer.from([VERSION]))
    decipher.setAuthTag(authTag)
    plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
  } catch {
    return new GiftCardClaimCryptoError()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return new GiftCardClaimCryptoError()
  }

  const claim = parseClaim(parsed)
  if (!claim) return new GiftCardClaimCryptoError()
  return claim
}
