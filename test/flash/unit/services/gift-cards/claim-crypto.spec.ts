/**
 * Claim data is the bearer value of a gift card — whoever holds the code holds
 * the money. These specs pin the at-rest envelope: AES-256-GCM under the
 * configured key, `version | iv | tag | data`, key identified by a sha256
 * prefix so rotation can be detected rather than guessed. Every check here
 * must be able to return "no": a tampered byte, a foreign key id, a short key
 * and a missing key all have to be refused, and no refusal may echo the code
 * or the key back in its message.
 */
import { createHash, randomBytes } from "crypto"

import { GiftCardsConfig } from "@config"
import { GiftCardClaimCryptoError } from "@domain/gift-cards"
import {
  decryptGiftCardClaim,
  encryptGiftCardClaim,
  giftCardClaimKeyId,
} from "@services/gift-cards/claim-crypto"

jest.mock("@config", () => ({
  GiftCardsConfig: { claimDataEncryptionKey: "" },
}))

const config = GiftCardsConfig as { claimDataEncryptionKey: string }

const KEY_BYTES = randomBytes(32)
const HEX_KEY = KEY_BYTES.toString("hex")
const BASE64_KEY = KEY_BYTES.toString("base64")
const EXPECTED_KEY_ID = createHash("sha256").update(KEY_BYTES).digest("hex").slice(0, 16)

const CLAIM: GiftCardClaim = {
  codes: [
    { label: "Card number", value: "6006-4931-0000-1234-567" },
    { label: "PIN", value: "8891" },
  ],
  claimLink: "https://example.test/claim/abc123",
  barcode: { chars: "600649310000123456", type: "CODE128" },
}

const setKey = (key: string) => {
  config.claimDataEncryptionKey = key
}

const flipByte = (ciphertext: string, offset: number): string => {
  const buf = Buffer.from(ciphertext, "base64")
  buf[offset] = buf[offset] ^ 0xff
  return buf.toString("base64")
}

const expectNoLeak = (err: Error) => {
  expect(err.message).not.toContain(CLAIM.codes[0].value)
  expect(err.message).not.toContain(CLAIM.codes[1].value)
  expect(err.message).not.toContain(HEX_KEY)
  expect(err.message).not.toContain(BASE64_KEY)
}

describe("gift card claim crypto", () => {
  beforeEach(() => setKey(HEX_KEY))

  describe("round trip", () => {
    it("decrypts to the claim it encrypted", () => {
      const sealed = encryptGiftCardClaim(CLAIM)
      if (sealed instanceof Error) throw sealed

      const opened = decryptGiftCardClaim(sealed)

      expect(opened).toEqual(CLAIM)
    })

    it("lays the envelope out as version | iv | tag | data and reports the key id", () => {
      const sealed = encryptGiftCardClaim(CLAIM)
      if (sealed instanceof Error) throw sealed

      const packed = Buffer.from(sealed.ciphertext, "base64")
      expect(packed[0]).toBe(0x01)
      // 1 version + 12 iv + 16 tag, then at least one byte of payload.
      expect(packed.length).toBeGreaterThan(1 + 12 + 16)
      expect(sealed.keyId).toBe(EXPECTED_KEY_ID)
      expect(sealed.keyId).toMatch(/^[0-9a-f]{16}$/)
      // The ciphertext carries no plaintext.
      expect(sealed.ciphertext).not.toContain(CLAIM.codes[0].value)
    })

    it("uses a fresh iv per call, so equal claims never share a ciphertext", () => {
      const a = encryptGiftCardClaim(CLAIM)
      const b = encryptGiftCardClaim(CLAIM)
      if (a instanceof Error) throw a
      if (b instanceof Error) throw b

      expect(a.ciphertext).not.toBe(b.ciphertext)
      expect(decryptGiftCardClaim(a)).toEqual(CLAIM)
      expect(decryptGiftCardClaim(b)).toEqual(CLAIM)
    })

    it("round-trips a minimal claim with nulls", () => {
      const minimal: GiftCardClaim = {
        codes: [{ label: null, value: "ONLYCODE" }],
        claimLink: null,
        barcode: null,
      }
      const sealed = encryptGiftCardClaim(minimal)
      if (sealed instanceof Error) throw sealed

      expect(decryptGiftCardClaim(sealed)).toEqual(minimal)
    })
  })

  describe("tamper detection", () => {
    it("refuses a ciphertext with one payload byte flipped", () => {
      const sealed = encryptGiftCardClaim(CLAIM)
      if (sealed instanceof Error) throw sealed

      // Last byte sits in the data region.
      const packedLength = Buffer.from(sealed.ciphertext, "base64").length
      const tampered = flipByte(sealed.ciphertext, packedLength - 1)

      const result = decryptGiftCardClaim({ ...sealed, ciphertext: tampered })

      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
      expectNoLeak(result as Error)
    })

    it("refuses a ciphertext with one auth tag byte flipped", () => {
      const sealed = encryptGiftCardClaim(CLAIM)
      if (sealed instanceof Error) throw sealed

      // Offsets 13..28 are the tag.
      const tampered = flipByte(sealed.ciphertext, 13)

      expect(decryptGiftCardClaim({ ...sealed, ciphertext: tampered })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })

    it("refuses a ciphertext with one iv byte flipped", () => {
      const sealed = encryptGiftCardClaim(CLAIM)
      if (sealed instanceof Error) throw sealed

      const tampered = flipByte(sealed.ciphertext, 1)

      expect(decryptGiftCardClaim({ ...sealed, ciphertext: tampered })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })

    it("refuses an unknown envelope version", () => {
      const sealed = encryptGiftCardClaim(CLAIM)
      if (sealed instanceof Error) throw sealed

      const tampered = flipByte(sealed.ciphertext, 0)

      expect(decryptGiftCardClaim({ ...sealed, ciphertext: tampered })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })

    it("refuses a ciphertext too short to hold the envelope", () => {
      const result = decryptGiftCardClaim({
        ciphertext: Buffer.from([0x01, 0x02, 0x03]).toString("base64"),
        keyId: EXPECTED_KEY_ID,
      })

      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
    })
  })

  describe("key id", () => {
    it("reports the current key's id", () => {
      expect(giftCardClaimKeyId()).toBe(EXPECTED_KEY_ID)
    })

    it("refuses to decrypt under a key id that is not the current key", () => {
      const sealed = encryptGiftCardClaim(CLAIM)
      if (sealed instanceof Error) throw sealed

      const result = decryptGiftCardClaim({
        ciphertext: sealed.ciphertext,
        keyId: "0123456789abcdef",
      })

      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
      expect((result as Error).message).toMatch(/key rotated/)
      expectNoLeak(result as Error)
    })

    it("reports a mismatch when the configured key changes under a sealed order", () => {
      const sealed = encryptGiftCardClaim(CLAIM)
      if (sealed instanceof Error) throw sealed

      setKey(randomBytes(32).toString("hex"))

      const result = decryptGiftCardClaim(sealed)
      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
      expect((result as Error).message).toMatch(/key rotated/)
    })
  })

  describe("key loading", () => {
    it("accepts a 64-char hex key", () => {
      setKey(HEX_KEY)
      expect(giftCardClaimKeyId()).toBe(EXPECTED_KEY_ID)
    })

    it("accepts a base64 key of 32 bytes and derives the same key id from the raw bytes", () => {
      setKey(HEX_KEY)
      const sealedUnderHex = encryptGiftCardClaim(CLAIM)
      if (sealedUnderHex instanceof Error) throw sealedUnderHex

      setKey(BASE64_KEY)
      expect(giftCardClaimKeyId()).toBe(EXPECTED_KEY_ID)
      // Same bytes, different encoding: the order sealed under the hex form
      // still opens.
      expect(decryptGiftCardClaim(sealedUnderHex)).toEqual(CLAIM)
    })

    it("tolerates surrounding whitespace from a config override", () => {
      setKey(`  ${HEX_KEY}\n`)
      expect(giftCardClaimKeyId()).toBe(EXPECTED_KEY_ID)
    })

    it("refuses an empty key rather than silently no-op'ing", () => {
      setKey("")

      const sealed = encryptGiftCardClaim(CLAIM)
      expect(sealed).toBeInstanceOf(GiftCardClaimCryptoError)
      expectNoLeak(sealed as Error)
      expect(giftCardClaimKeyId()).toBeInstanceOf(GiftCardClaimCryptoError)
      expect(
        decryptGiftCardClaim({ ciphertext: "AAAA", keyId: EXPECTED_KEY_ID }),
      ).toBeInstanceOf(GiftCardClaimCryptoError)
    })

    it("refuses a whitespace-only key", () => {
      setKey("   ")
      expect(encryptGiftCardClaim(CLAIM)).toBeInstanceOf(GiftCardClaimCryptoError)
    })

    it("refuses a 31-byte key in hex", () => {
      setKey(randomBytes(31).toString("hex"))
      const result = encryptGiftCardClaim(CLAIM)
      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
      expectNoLeak(result as Error)
    })

    it("refuses a 31-byte key in base64", () => {
      setKey(randomBytes(31).toString("base64"))
      expect(encryptGiftCardClaim(CLAIM)).toBeInstanceOf(GiftCardClaimCryptoError)
    })

    it("refuses a 33-byte key in base64", () => {
      setKey(randomBytes(33).toString("base64"))
      expect(encryptGiftCardClaim(CLAIM)).toBeInstanceOf(GiftCardClaimCryptoError)
    })

    it("refuses a key that is neither hex nor base64", () => {
      setKey("not-a-key!@#$%^&*()")
      expect(encryptGiftCardClaim(CLAIM)).toBeInstanceOf(GiftCardClaimCryptoError)
    })
  })
})
