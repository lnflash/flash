import { PaymentSplitsConfig } from "@config"

import { checkedToUsername } from "@domain/accounts"
import { InvalidWalletForAccountError } from "@domain/accounts/errors"
import {
  PaymentSplitsDisabledError,
  SplitDestinationNotFoundError,
  validateSplitSet,
  type SplitSetEntry,
} from "@domain/payment-splits"
import { checkedToWalletId } from "@domain/wallets"

import { LockService } from "@services/lock"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import {
  PaymentSplitRulesRepository,
  type PaymentSplitRuleRecord,
} from "@services/mongoose/payment-split-rules"

export type SplitInput = { destination: string; percent: number }

/**
 * Resolves the source wallet of a split mutation and re-checks that it belongs
 * to the calling account. The wallet-id middleware already enforces this for
 * every atWalletLevel mutation; this is defense in depth.
 */
export const resolveOwnedWallet = async ({
  account,
  walletId: uncheckedWalletId,
}: {
  account: Account
  walletId: string
}): Promise<Wallet | ApplicationError> => {
  const walletId = checkedToWalletId(uncheckedWalletId)
  if (walletId instanceof Error) return walletId

  const wallet = await WalletsRepository().findById(walletId)
  if (wallet instanceof Error) return wallet
  if (wallet.accountId !== account.id) return new InvalidWalletForAccountError()
  return wallet
}

/**
 * A destination is either a walletId or a Flash username. A username resolves
 * to that account's wallet in the SOURCE wallet's currency — not to its
 * default wallet, which may be BTC or the other cash currency.
 */
const resolveDestination = async ({
  destination,
  sourceCurrency,
}: {
  destination: string
  sourceCurrency: WalletCurrency
}): Promise<Wallet | ApplicationError> => {
  const trimmed = destination.trim()

  const walletId = checkedToWalletId(trimmed)
  if (!(walletId instanceof Error)) {
    const wallet = await WalletsRepository().findById(walletId)
    if (wallet instanceof Error) {
      return new SplitDestinationNotFoundError(`No wallet found for ${trimmed}`)
    }
    return wallet
  }

  const username = checkedToUsername(trimmed.replace(/^@/, ""))
  if (username instanceof Error) {
    return new SplitDestinationNotFoundError(`No Flash user found for ${trimmed}`)
  }

  const account = await AccountsRepository().findByUsername(username)
  if (account instanceof Error) {
    return new SplitDestinationNotFoundError(`No Flash user found for ${trimmed}`)
  }

  const wallets = await WalletsRepository().listByAccountId(account.id)
  if (wallets instanceof Error) return wallets

  const match = wallets.find((wallet) => wallet.currency === sourceCurrency)
  if (!match) {
    return new SplitDestinationNotFoundError(
      `${trimmed} has no ${sourceCurrency} wallet to receive splits`,
    )
  }
  return match
}

/**
 * Replaces the wallet's split rules with `splits`. Runs under the wallet lock
 * so two concurrent sets cannot interleave their delete/insert and leave the
 * wallet with more than 100% allocated.
 */
export const setPaymentSplits = async ({
  account,
  walletId,
  splits,
}: {
  account: Account
  walletId: string
  splits: SplitInput[]
}): Promise<PaymentSplitRuleRecord[] | ApplicationError> => {
  if (!PaymentSplitsConfig.enabled) return new PaymentSplitsDisabledError()

  const sourceWallet = await resolveOwnedWallet({ account, walletId })
  if (sourceWallet instanceof Error) return sourceWallet

  const entries: SplitSetEntry[] = []
  for (const { destination, percent } of splits) {
    const destinationWallet = await resolveDestination({
      destination,
      sourceCurrency: sourceWallet.currency,
    })
    if (destinationWallet instanceof Error) return destinationWallet
    entries.push({
      destinationWalletId: destinationWallet.id,
      destinationCurrency: destinationWallet.currency,
      percent,
    })
  }

  const valid = validateSplitSet({
    sourceWalletId: sourceWallet.id,
    sourceCurrency: sourceWallet.currency,
    entries,
  })
  if (valid instanceof Error) return valid

  return LockService().lockWalletId(sourceWallet.id, async () =>
    PaymentSplitRulesRepository().replaceForWallet(
      sourceWallet.id,
      entries.map(({ destinationWalletId, percent }) => ({
        destinationWalletId,
        percent,
      })),
    ),
  )
}
