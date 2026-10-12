import { ValidationError } from "@domain/shared"

import {
  InvalidSplitPercentError,
  SelfSplitNotAllowedError,
  SplitCurrencyMismatchError,
  SplitDuplicateDestinationError,
  SplitPercentExceededError,
  SplitRuleLimitExceededError,
} from "./errors"
import { isSplitCurrency } from "./compute-share"

export const MAX_SPLIT_RULES_PER_WALLET = 10

export type SplitSetEntry = {
  destinationWalletId: string
  destinationCurrency: string
  percent: number
}

/**
 * Validates a complete split set for one source wallet. The set replaces any
 * existing rules, so the percent sum is checked over this set alone.
 */
export const validateSplitSet = ({
  sourceWalletId,
  sourceCurrency,
  entries,
  maxRules = MAX_SPLIT_RULES_PER_WALLET,
}: {
  sourceWalletId: string
  sourceCurrency: string
  entries: SplitSetEntry[]
  maxRules?: number
}): true | ValidationError => {
  if (!isSplitCurrency(sourceCurrency)) {
    return new SplitCurrencyMismatchError("Splits are only supported on USD wallets")
  }

  if (entries.length > maxRules) {
    return new SplitRuleLimitExceededError(
      `A wallet can have at most ${maxRules} payment splits`,
    )
  }

  for (const { percent } of entries) {
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      return new InvalidSplitPercentError(
        "Each split percent must be a whole number from 1 to 100",
      )
    }
  }

  const sum = entries.reduce((total, { percent }) => total + percent, 0)
  if (sum <= 0 || sum > 100) {
    return new SplitPercentExceededError(
      "Split percentages must add up to more than 0 and at most 100",
    )
  }

  const seen = new Set<string>()
  for (const { destinationWalletId, destinationCurrency } of entries) {
    if (destinationWalletId === sourceWalletId) {
      return new SelfSplitNotAllowedError("A wallet cannot split payments to itself")
    }
    if (seen.has(destinationWalletId)) {
      return new SplitDuplicateDestinationError(
        "Each split destination can appear only once",
      )
    }
    seen.add(destinationWalletId)
    if (destinationCurrency !== sourceCurrency) {
      return new SplitCurrencyMismatchError(
        "Split destination wallet must be in the same currency as the source wallet",
      )
    }
  }

  return true
}
