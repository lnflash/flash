/**
 * Flash Cashu service layer.
 *
 * Thin wrappers around @lnflash/cashu-client mint functions that:
 *  1. Inject the configured mint URL from Flash's YAML config
 *  2. Map package-level CashuError instances to Flash DomainError subclasses
 *     (preserving ErrorLevel metadata for Flash's logging/error handling)
 */
import {
  requestMintQuote as _requestMintQuote,
  getMintQuoteState as _getMintQuoteState,
  getMintKeysets as _getMintKeysets,
  getMintKeyset as _getMintKeyset,
  mintProofs as _mintProofs,
  CashuError,
} from "@lnflash/cashu-client"

import type { CashuMintQuote, CashuBlindedMessage, CashuBlindSignature, CashuKeyset, CashuKeysetDetail } from "@lnflash/cashu-client"

import { CashuMintError } from "@domain/cashu"
import { getCashuConfig } from "@config"

const mintUrl = () => getCashuConfig().mintUrl

const wrapError = (err: CashuError): CashuMintError =>
  new CashuMintError(err.message)

export const requestMintQuote = async (
  amountCents: number,
): Promise<CashuMintQuote | CashuMintError> => {
  const result = await _requestMintQuote(mintUrl(), amountCents, "usd")
  return result instanceof CashuError ? wrapError(result) : result
}

export const getMintQuoteState = async (
  quoteId: string,
): Promise<CashuMintQuote | CashuMintError> => {
  const result = await _getMintQuoteState(mintUrl(), quoteId)
  return result instanceof CashuError ? wrapError(result) : result
}

export const getMintKeysets = async (): Promise<CashuKeyset[] | CashuMintError> => {
  const result = await _getMintKeysets(mintUrl())
  return result instanceof CashuError ? wrapError(result) : result
}

export const getMintKeyset = async (
  keysetId: string,
): Promise<CashuKeysetDetail | CashuMintError> => {
  const result = await _getMintKeyset(mintUrl(), keysetId)
  return result instanceof CashuError ? wrapError(result) : result
}

export const mintProofs = async (
  quoteId: string,
  blindedMessages: CashuBlindedMessage[],
): Promise<CashuBlindSignature[] | CashuMintError> => {
  const result = await _mintProofs(mintUrl(), quoteId, blindedMessages)
  return result instanceof CashuError ? wrapError(result) : result
}
