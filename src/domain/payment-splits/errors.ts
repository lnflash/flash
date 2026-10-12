import { DomainError, ErrorLevel, ValidationError } from "@domain/shared"

// ENG-653 payment splits. Every class exported here is an ApplicationError key
// and therefore needs a case in src/graphql/error-map.ts.

// The percentages of a wallet's split set must sum to more than 0 and at most
// 100 (an empty set sums to 0).
export class SplitPercentExceededError extends ValidationError {}
// A single percent is not an integer in [1, 100].
export class InvalidSplitPercentError extends ValidationError {}
// More rules than MAX_SPLIT_RULES_PER_WALLET in one set.
export class SplitRuleLimitExceededError extends ValidationError {}
// The destination username or walletId does not resolve to a wallet in the
// source wallet's currency.
export class SplitDestinationNotFoundError extends ValidationError {}
export class SelfSplitNotAllowedError extends ValidationError {}
// The destination wallet's currency differs from the source wallet's, or the
// source wallet is not a USD/USDT wallet. send-intraledger rejects
// cross-currency sends, so such a rule could never pay out.
export class SplitCurrencyMismatchError extends ValidationError {}
export class SplitDuplicateDestinationError extends ValidationError {}
export class SplitRuleNotFoundError extends ValidationError {}
export class PaymentSplitsDisabledError extends ValidationError {}

// The internal-transfer marker could not be persisted before paying an
// intraledger invoice. The send is refused (no money moved) so that the
// recipient's split rules can never fire on a system credit.
export class InternalTransferMarkerError extends DomainError {
  level = ErrorLevel.Critical
}
