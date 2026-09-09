import { ValidationError, ErrorLevel } from "@domain/shared"

export class InvalidZeroAmountPriceRatioInputError extends ValidationError {}
export class SubOneCentSatAmountForUsdSelfSendError extends ValidationError {}
export class LnPaymentRequestNonZeroAmountRequiredError extends ValidationError {}
export class LnPaymentRequestZeroAmountRequiredError extends ValidationError {}
export class LnPaymentRequestInTransitError extends ValidationError {}
export class LnHashPresentInIntraLedgerFlowError extends ValidationError {}
export class IntraLedgerHashPresentInLnFlowError extends ValidationError {}
export class SkipProbeForPubkeyError extends ValidationError {}
export class NonLnPaymentTransactionForPaymentFlowError extends ValidationError {
  level = ErrorLevel.Critical
}
export class MissingPropsInTransactionForPaymentFlowError extends ValidationError {
  level = ErrorLevel.Critical
}
export class InvalidLightningPaymentFlowBuilderStateError extends ValidationError {
  level = ErrorLevel.Critical
}
export class InvalidLightningPaymentFlowStateError extends ValidationError {
  level = ErrorLevel.Critical
}

export class InvalidOnChainPaymentFlowBuilderStateError extends ValidationError {
  level = ErrorLevel.Critical
}

// ENG-573 send guard (src/app/payments/authorize-send.ts).
// The amount reaching a send mutation was not a positive, finite number: zero,
// negative, NaN, or a non-integer where the unit (sats) has no fractions.
export class InvalidSendAmountError extends ValidationError {}
// The guard could not establish the caller's daily limit (no limit configured
// for the account level, or the BTC→USD price needed to apply it was
// unavailable). The guard fails closed, so this rejects the send.
export class SendLimitsUnavailableError extends ValidationError {
  level = ErrorLevel.Critical
}
