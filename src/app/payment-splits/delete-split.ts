import { PaymentSplitsConfig } from "@config"

import {
  PaymentSplitsDisabledError,
  SplitRuleNotFoundError,
} from "@domain/payment-splits"

import { LockService } from "@services/lock"
import { PaymentSplitRulesRepository } from "@services/mongoose/payment-split-rules"

import { resolveOwnedWallet } from "./set-splits"

/**
 * Deletes one split rule. Executions already recorded for it are left alone
 * and still pay out: they belong to receives that arrived while it existed.
 */
export const deletePaymentSplit = async ({
  account,
  walletId,
  splitId,
}: {
  account: Account
  walletId: string
  splitId: string
}): Promise<true | ApplicationError> => {
  if (!PaymentSplitsConfig.enabled) return new PaymentSplitsDisabledError()

  const wallet = await resolveOwnedWallet({ account, walletId })
  if (wallet instanceof Error) return wallet

  return LockService().lockWalletId(wallet.id, async () => {
    const rules = PaymentSplitRulesRepository()
    const rule = await rules.findById(splitId)
    if (rule instanceof Error) return rule
    if (rule === null || rule.walletId !== wallet.id) {
      return new SplitRuleNotFoundError(splitId)
    }

    const deleted = await rules.deleteById(rule.id)
    if (deleted instanceof Error) return deleted
    if (!deleted) return new SplitRuleNotFoundError(splitId)
    return true as const
  })
}
