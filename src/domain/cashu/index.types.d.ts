type CashuProof = {
  id: string        // keyset ID (hex, e.g. "0059534ce0bfa19a")
  amount: number    // denomination in keyset base unit (cents for USD)
  secret: string    // NUT-10 P2PK secret JSON string
  C: string         // mint signature (compressed secp256k1 point, hex)
}

type CashuCardProvisionResult = {
  proofs: CashuProof[]
  cardPubkey: string
  totalAmount: number // cents
}

type CashuMintQuote = {
  quoteId: string
  paymentRequest: string // bolt11 invoice
  state: "UNPAID" | "PAID" | "ISSUED" | "EXPIRED"
  expiry: number // unix timestamp
}

type CashuBlindedMessage = {
  id: string     // keyset ID
  amount: number
  B_: string     // blinded point hex (compressed)
}

type CashuBlindSignature = {
  id: string
  amount: number
  C_: string     // blind signature hex (compressed)
}

type CashuBlindingData = {
  secret: string  // the raw 32-byte nonce (hex) — stored on card
  r: Uint8Array   // blinding factor scalar
  B_: string      // blinded point hex
  amount: number
}
