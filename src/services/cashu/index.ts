import axios from "axios"

import { CashuMintError } from "@domain/cashu"
import { baseLogger } from "@services/logger"

const logger = baseLogger.child({ module: "cashu-service" })

const MINT_URL = process.env.CASHU_MINT_URL ?? "https://forge.flashapp.me"
const MINT_UNIT = "usd" // USD cents

/**
 * Request a mint quote (returns a bolt11 invoice to pay).
 * NUT-04: POST /v1/mint/quote/bolt11
 */
export const requestMintQuote = async (
  amountCents: number,
): Promise<CashuMintQuote | CashuMintError> => {
  try {
    const resp = await axios.post(`${MINT_URL}/v1/mint/quote/bolt11`, {
      amount: amountCents,
      unit: MINT_UNIT,
    })
    const data = resp.data
    return {
      quoteId: data.quote,
      paymentRequest: data.request,
      state: data.state,
      expiry: data.expiry,
    }
  } catch (err) {
    logger.error({ err }, "cashu: requestMintQuote failed")
    return new CashuMintError(`Mint quote request failed: ${(err as Error).message}`)
  }
}

/**
 * Check the state of a mint quote.
 * NUT-04: GET /v1/mint/quote/bolt11/:quoteId
 */
export const getMintQuoteState = async (
  quoteId: string,
): Promise<CashuMintQuote | CashuMintError> => {
  try {
    const resp = await axios.get(`${MINT_URL}/v1/mint/quote/bolt11/${quoteId}`)
    const data = resp.data
    return {
      quoteId: data.quote,
      paymentRequest: data.request,
      state: data.state,
      expiry: data.expiry,
    }
  } catch (err) {
    logger.error({ err }, "cashu: getMintQuoteState failed")
    return new CashuMintError(`Mint quote state check failed: ${(err as Error).message}`)
  }
}

/**
 * Fetch the active keysets from the mint.
 * NUT-01: GET /v1/keysets
 * Returns a map of keyset_id → { unit, active, keys: { amount: pubkey_hex } }
 */
export const getMintKeysets = async (): Promise<
  { id: string; unit: string; active: boolean }[] | CashuMintError
> => {
  try {
    const resp = await axios.get(`${MINT_URL}/v1/keysets`)
    return resp.data.keysets
  } catch (err) {
    logger.error({ err }, "cashu: getMintKeysets failed")
    return new CashuMintError(`Mint keyset fetch failed: ${(err as Error).message}`)
  }
}

/**
 * Fetch the public keys for a specific keyset.
 * NUT-01: GET /v1/keys/:keysetId
 * Returns { id, unit, keys: { "1": hex, "2": hex, ... } }
 */
export const getMintKeyset = async (
  keysetId: string,
): Promise<{ id: string; unit: string; keys: Record<string, string> } | CashuMintError> => {
  try {
    const resp = await axios.get(`${MINT_URL}/v1/keys/${keysetId}`)
    // Response wraps in { keysets: [{ id, unit, keys }] }
    const ks = resp.data.keysets?.[0] ?? resp.data
    return ks
  } catch (err) {
    logger.error({ err }, "cashu: getMintKeyset failed")
    return new CashuMintError(`Mint keyset fetch failed: ${(err as Error).message}`)
  }
}

/**
 * Submit blinded messages to mint and receive blind signatures.
 * NUT-04: POST /v1/mint/bolt11
 */
export const mintProofs = async (
  quoteId: string,
  blindedMessages: CashuBlindedMessage[],
): Promise<CashuBlindSignature[] | CashuMintError> => {
  try {
    const resp = await axios.post(`${MINT_URL}/v1/mint/bolt11`, {
      quote: quoteId,
      outputs: blindedMessages.map((bm) => ({
        id: bm.id,
        amount: bm.amount,
        B_: bm.B_,
      })),
    })
    return resp.data.signatures.map(
      (sig: { id: string; amount: number; C_: string }) => ({
        id: sig.id,
        amount: sig.amount,
        C_: sig.C_,
      }),
    )
  } catch (err) {
    logger.error({ err }, "cashu: mintProofs failed")
    return new CashuMintError(`Mint proof issuance failed: ${(err as Error).message}`)
  }
}
