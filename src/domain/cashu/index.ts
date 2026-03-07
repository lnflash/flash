import crypto from "crypto"
import * as secp from "tiny-secp256k1"

export * from "./errors"

const DOMAIN_SEPARATOR = Buffer.from("Secp256k1_HashToCurve_Cashu_", "utf8")

/**
 * NUT-00: hash_to_curve
 * Deterministically maps a 32-byte secret to a secp256k1 point.
 */
export const hashToCurve = (secret: Buffer): Uint8Array => {
  const msgHash = crypto
    .createHash("sha256")
    .update(Buffer.concat([DOMAIN_SEPARATOR, secret]))
    .digest()

  for (let counter = 0; counter < 2 ** 16; counter++) {
    const counterBuf = Buffer.alloc(4)
    counterBuf.writeUInt32BE(counter)
    const candidate = Buffer.concat([
      Buffer.from([0x02]),
      crypto.createHash("sha256").update(Buffer.concat([msgHash, counterBuf])).digest(),
    ])
    if (secp.isPoint(candidate)) return candidate
  }
  throw new Error("hash_to_curve: no valid point found after 2^16 iterations")
}

/**
 * Split an amount (in cents) into Cashu power-of-2 denominations.
 * Returns an array of amounts (each a power of 2), summing to totalCents.
 * Uses standard Cashu denomination splitting: greedy from highest bit.
 */
export const splitIntoDenominations = (totalCents: number): number[] => {
  const denominations: number[] = []
  let remaining = totalCents
  // Powers of 2 from 2^15 down to 2^0
  for (let bit = 15; bit >= 0; bit--) {
    const denom = 1 << bit
    while (remaining >= denom) {
      denominations.push(denom)
      remaining -= denom
    }
  }
  return denominations
}

/**
 * Build the canonical NUT-10 P2PK secret JSON string for a card proof.
 * The JSON MUST have no spaces and keys in specified order.
 *
 * secret = ["P2PK", {"nonce": "<hex>", "data": "<cardPubkey>", "tags": [["sigflag", "SIG_INPUTS"]]}]
 */
export const buildP2PKSecret = (nonce: string, cardPubkey: string): string => {
  return (
    `["P2PK",{"nonce":"${nonce}","data":"${cardPubkey}","tags":[["sigflag","SIG_INPUTS"]]}]`
  )
}

/**
 * NUT-03: Create a blinded message for a given denomination.
 * Returns the blinding data needed to unblind the mint's response.
 *
 * B_ = hash_to_curve(secret) + r*G
 */
export const createBlindedMessage = (
  keysetId: string,
  amount: number,
  cardPubkey: string,
): CashuBlindingData => {
  // Generate random 32-byte nonce
  const nonce = crypto.randomBytes(32)
  const nonceHex = nonce.toString("hex")

  // Build the P2PK secret string
  const secretStr = buildP2PKSecret(nonceHex, cardPubkey)
  const secretBytes = Buffer.from(secretStr, "utf8")

  // hash_to_curve(secret)
  const Y = hashToCurve(secretBytes)

  // Random blinding factor r
  let r: Uint8Array
  do {
    r = crypto.randomBytes(32)
  } while (!secp.isPrivate(r))

  // B_ = Y + r*G
  const rG = secp.pointFromScalar(r, true)
  if (!rG) throw new Error("pointFromScalar failed")

  const B_ = secp.pointAdd(Y, rG, true)
  if (!B_) throw new Error("pointAdd failed for B_")

  return {
    nonce: nonceHex,   // stored on card (compact form)
    secretStr,          // full Proof.secret string (P2PK JSON)
    r,
    B_: Buffer.from(B_).toString("hex"),
    amount,
  }
}

/**
 * NUT-03: Unblind a mint signature.
 * C = C_ - r*K
 * where K is the mint's public key for this keyset/amount.
 */
export const unblindSignature = (
  C_hex: string,
  r: Uint8Array,
  mintPubkeyHex: string,
): string => {
  const C_ = Buffer.from(C_hex, "hex")
  const K = Buffer.from(mintPubkeyHex, "hex")

  // r*K
  const rK = secp.pointMultiply(K, r, true)
  if (!rK) throw new Error("pointMultiply failed for r*K")

  // Negate r*K → -r*K
  // Negating a compressed point: flip parity byte (02 ↔ 03)
  const rKNeg = Buffer.from(rK)
  rKNeg[0] = rKNeg[0] === 0x02 ? 0x03 : 0x02

  // C = C_ + (-r*K)
  const C = secp.pointAdd(C_, rKNeg, true)
  if (!C) throw new Error("pointAdd failed for C = C_ - r*K")

  return Buffer.from(C).toString("hex")
}
