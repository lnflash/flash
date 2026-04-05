/**
 * Cashu domain layer — re-exports from @lnflash/cashu-client plus Flash error wrappers.
 *
 * Crypto primitives and types live in the standalone package.
 * Flash-specific DomainError subclasses live in ./errors.
 */
export {
  hashToCurve,
  splitIntoDenominations,
  buildP2PKSecret,
  createBlindedMessage,
  unblindSignature,
} from "@lnflash/cashu-client"

export type {
  CashuProof,
  CashuMintQuote,
  CashuBlindedMessage,
  CashuBlindSignature,
  CashuBlindingData,
  CashuKeyset,
  CashuKeysetDetail,
} from "@lnflash/cashu-client"

export * from "./errors"
