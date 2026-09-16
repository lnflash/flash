/**
 * Claim data is the bearer value of a gift card — whoever holds the code holds
 * the money. These specs pin the at-rest envelope: AES-256-GCM under the
 * configured key, `version | iv | tag | data`, key identified by a sha256
 * prefix so rotation can be detected rather than guessed, and the order id
 * bound into the authenticated data so a ciphertext only opens on the row it
 * was sealed for. Every check here must be able to return "no": a tampered
 * byte, a foreign key id, another order's id, a short key and a missing key
 * all have to be refused, and no refusal may echo the code or the key back in
 * its message.
 */
import { createHash, randomBytes } from "crypto"

import { GiftCardsConfig } from "@config"
import { GiftCardClaimCryptoError } from "@domain/gift-cards"
import {
  claimCryptoReady,
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

const ORDER_ID = "1f9d2c4e-8b7a-4c3d-9e2f-0a1b2c3d4e5f" as GiftCardOrderId
const OTHER_ORDER_ID = "7d2e1b9a-3c4f-4a5b-8c6d-9e0f1a2b3c4d" as GiftCardOrderId

const setKey = (key: string) => {
  config.claimDataEncryptionKey = key
}

const seal = (claim: GiftCardClaim = CLAIM, orderId: GiftCardOrderId = ORDER_ID) => {
  const sealed = encryptGiftCardClaim(claim, { orderId })
  if (sealed instanceof Error) throw sealed
  return sealed
}

/** Open under the order it was sealed for unless told otherwise. */
const open = (
  sealed: { ciphertext: string; keyId: string },
  orderId: GiftCardOrderId = ORDER_ID,
) => decryptGiftCardClaim({ ...sealed, orderId })

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
      const sealed = seal()

      const opened = open(sealed)

      expect(opened).toEqual(CLAIM)
    })

    it("lays the envelope out as version | iv | tag | data and reports the key id", () => {
      const sealed = seal()

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
      const a = seal()
      const b = seal()

      expect(a.ciphertext).not.toBe(b.ciphertext)
      expect(open(a)).toEqual(CLAIM)
      expect(open(b)).toEqual(CLAIM)
    })

    it("round-trips a minimal claim with nulls", () => {
      const minimal: GiftCardClaim = {
        codes: [{ label: null, value: "ONLYCODE" }],
        claimLink: null,
        barcode: null,
      }
      const sealed = seal(minimal)

      expect(open(sealed)).toEqual(minimal)
    })
  })

  describe("order binding", () => {
    it("refuses to open a ciphertext under a different order id", () => {
      // Anyone with write access to the orders collection can copy one row's
      // `claimCiphertext` onto another. The order id is authenticated data, so
      // the tag does not verify there.
      const sealed = seal(CLAIM, ORDER_ID)

      const result = open(sealed, OTHER_ORDER_ID)

      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
      expectNoLeak(result as Error)
      expect((result as Error).message).not.toContain(ORDER_ID)
    })

    it("the order id does not appear in the ciphertext", () => {
      const sealed = seal(CLAIM, ORDER_ID)
      expect(Buffer.from(sealed.ciphertext, "base64").toString("utf8")).not.toContain(
        ORDER_ID,
      )
    })

    it("two orders sealing the same claim each open only their own", () => {
      const a = seal(CLAIM, ORDER_ID)
      const b = seal(CLAIM, OTHER_ORDER_ID)

      expect(open(a, ORDER_ID)).toEqual(CLAIM)
      expect(open(b, OTHER_ORDER_ID)).toEqual(CLAIM)
      expect(open(a, OTHER_ORDER_ID)).toBeInstanceOf(GiftCardClaimCryptoError)
      expect(open(b, ORDER_ID)).toBeInstanceOf(GiftCardClaimCryptoError)
    })
  })

  describe("tamper detection", () => {
    it("refuses a ciphertext with one payload byte flipped", () => {
      const sealed = seal()

      // Last byte sits in the data region.
      const packedLength = Buffer.from(sealed.ciphertext, "base64").length
      const tampered = flipByte(sealed.ciphertext, packedLength - 1)

      const result = open({ ...sealed, ciphertext: tampered })

      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
      expectNoLeak(result as Error)
    })

    it("refuses a ciphertext with one auth tag byte flipped", () => {
      const sealed = seal()

      // Offsets 13..28 are the tag.
      const tampered = flipByte(sealed.ciphertext, 13)

      expect(open({ ...sealed, ciphertext: tampered })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })

    it("refuses a ciphertext with one iv byte flipped", () => {
      const sealed = seal()

      const tampered = flipByte(sealed.ciphertext, 1)

      expect(open({ ...sealed, ciphertext: tampered })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })

    it("refuses an unknown envelope version", () => {
      const sealed = seal()

      const tampered = flipByte(sealed.ciphertext, 0)

      expect(open({ ...sealed, ciphertext: tampered })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })

    it("refuses a ciphertext too short to hold the envelope", () => {
      const result = decryptGiftCardClaim({
        ciphertext: Buffer.from([0x01, 0x02, 0x03]).toString("base64"),
        keyId: EXPECTED_KEY_ID,
        orderId: ORDER_ID,
      })

      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
    })

    it.each([
      ["an empty string", ""],
      ["characters outside the base64 alphabet", "AQID!@#$"],
      ["a length that is not a whole number of quads", "AQIDB"],
      ["padding in the middle", "AQ==ID"],
      ["three padding characters", "A==="],
      ["whitespace", "AQID AQID"],
    ])(
      "refuses malformed base64 (%s) instead of silently decoding what it can",
      (_label, ciphertext) => {
        // `Buffer.from(x, "base64")` never throws: it skips bad characters and
        // decodes the rest, which is how a corrupt row turns into a confusing
        // "tag mismatch" instead of a clear "malformed". Strict check first.
        const result = decryptGiftCardClaim({
          ciphertext,
          keyId: EXPECTED_KEY_ID,
          orderId: ORDER_ID,
        })

        expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
        expect((result as Error).message).toMatch(/malformed/)
      },
    )
  })

  describe("key id", () => {
    it("reports the current key's id", () => {
      expect(giftCardClaimKeyId()).toBe(EXPECTED_KEY_ID)
    })

    it("refuses to decrypt under a key id that is not the current key", () => {
      const sealed = seal()

      const result = decryptGiftCardClaim({
        ciphertext: sealed.ciphertext,
        keyId: "0123456789abcdef",
        orderId: ORDER_ID,
      })

      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
      expect((result as Error).message).toMatch(/key rotated/)
      expectNoLeak(result as Error)
    })

    it("reports a mismatch when the configured key changes under a sealed order", () => {
      const sealed = seal()

      setKey(randomBytes(32).toString("hex"))

      const result = open(sealed)
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
      const sealedUnderHex = seal()

      setKey(BASE64_KEY)
      expect(giftCardClaimKeyId()).toBe(EXPECTED_KEY_ID)
      // Same bytes, different encoding: the order sealed under the hex form
      // still opens.
      expect(open(sealedUnderHex)).toEqual(CLAIM)
    })

    it("tolerates surrounding whitespace from a config override", () => {
      setKey(`  ${HEX_KEY}\n`)
      expect(giftCardClaimKeyId()).toBe(EXPECTED_KEY_ID)
    })

    it("refuses an empty key rather than silently no-op'ing", () => {
      setKey("")

      const sealed = encryptGiftCardClaim(CLAIM, { orderId: ORDER_ID })
      expect(sealed).toBeInstanceOf(GiftCardClaimCryptoError)
      expectNoLeak(sealed as Error)
      expect(giftCardClaimKeyId()).toBeInstanceOf(GiftCardClaimCryptoError)
      expect(
        decryptGiftCardClaim({
          ciphertext: "AAAA",
          keyId: EXPECTED_KEY_ID,
          orderId: ORDER_ID,
        }),
      ).toBeInstanceOf(GiftCardClaimCryptoError)
    })

    it("refuses a whitespace-only key", () => {
      setKey("   ")
      expect(encryptGiftCardClaim(CLAIM, { orderId: ORDER_ID })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })

    it("refuses a 31-byte key in hex", () => {
      setKey(randomBytes(31).toString("hex"))
      const result = encryptGiftCardClaim(CLAIM, { orderId: ORDER_ID })
      expect(result).toBeInstanceOf(GiftCardClaimCryptoError)
      expectNoLeak(result as Error)
    })

    it("refuses a 31-byte key in base64", () => {
      setKey(randomBytes(31).toString("base64"))
      expect(encryptGiftCardClaim(CLAIM, { orderId: ORDER_ID })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })

    it("refuses a 33-byte key in base64", () => {
      setKey(randomBytes(33).toString("base64"))
      expect(encryptGiftCardClaim(CLAIM, { orderId: ORDER_ID })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })

    it("refuses a key that is neither hex nor base64", () => {
      setKey("not-a-key!@#$%^&*()")
      expect(encryptGiftCardClaim(CLAIM, { orderId: ORDER_ID })).toBeInstanceOf(
        GiftCardClaimCryptoError,
      )
    })
  })

  describe("claimCryptoReady", () => {
    // The purchase path asks this before paying: a card we could not store the
    // code for is a customer who paid for something they cannot see.
    it("is true with a valid key and encrypts nothing", () => {
      setKey(HEX_KEY)
      expect(claimCryptoReady()).toBe(true)
    })

    it.each([
      ["missing", ""],
      ["whitespace-only", "   "],
      ["31 bytes of hex", randomBytes(31).toString("hex")],
      ["33 bytes of base64", randomBytes(33).toString("base64")],
      ["garbage", "not-a-key!@#$%^&*()"],
    ])("reports a %s key as not ready", (_label, key) => {
      setKey(key)
      expect(claimCryptoReady()).toBeInstanceOf(GiftCardClaimCryptoError)
    })

    it.each([
      ["31 bytes of hex", randomBytes(31).toString("hex")],
      ["33 bytes of base64", randomBytes(33).toString("base64")],
      ["garbage", "not-a-key!@#$%^&*()"],
    ])("never echoes a rejected %s key in its message", (_label, key) => {
      setKey(key)
      const result = claimCryptoReady()
      expect((result as Error).message).not.toContain(key)
    })

    it("agrees with encrypt: ready ⇔ encrypt succeeds", () => {
      for (const key of [HEX_KEY, BASE64_KEY, "", randomBytes(31).toString("hex")]) {
        setKey(key)
        const ready = claimCryptoReady()
        const sealed = encryptGiftCardClaim(CLAIM, { orderId: ORDER_ID })
        expect(ready === true).toBe(!(sealed instanceof Error))
      }
    })
  })
})
