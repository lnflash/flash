import { PaymentSplitsConfig } from "@config"

import { AccountValidator, checkedToUsername } from "@domain/accounts"
import { InvalidWalletForAccountError } from "@domain/accounts/errors"
import {
  PaymentSplitsDisabledError,
  SplitDestinationInactiveError,
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

import { ensureReceiveAccount } from "./receive-account"

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
 * ENG-660: a destination whose account is not active (closed, locked, pending)
 * would fail every payout with InactiveAccountError, so it is refused at save
 * time. Uses the same AccountValidator check the intraledger send applies to
 * the recipient.
 */
const checkDestinationActive = (
  account: Account,
  destination: string,
): true | SplitDestinationInactiveError => {
  if (AccountValidator(account).isActive() instanceof Error) {
    return new SplitDestinationInactiveError(
      `Split destination account is not active: ${destination}`,
    )
  }
  return true
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
    const owner = await AccountsRepository().findById(wallet.accountId)
    if (owner instanceof Error) {
      return new SplitDestinationNotFoundError(`No wallet found for ${trimmed}`)
    }
    const active = checkDestinationActive(owner, trimmed)
    if (active instanceof Error) return active
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
  const active = checkDestinationActive(account, trimmed)
  if (active instanceof Error) return active

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

  return LockService().lockWalletId(sourceWallet.id, async () => {
    // ENG-717: the shadow receive account must exist before rules go live, or
    // routing (receiveAccountFor) would fall back to the real account and
    // split nothing. A non-empty set creates it; clearing the rules keeps the
    // existing shadow (decision 4: permanent). Creation failure fails the
    // mutation, so a wallet is never left with enabled rules and no shadow.
    if (entries.length > 0) {
      const shadow = await ensureReceiveAccount({
        walletId: sourceWallet.id,
        currency: sourceWallet.currency,
      })
      if (shadow instanceof Error) return shadow
    }

    return PaymentSplitRulesRepository().replaceForWallet(
      sourceWallet.id,
      entries.map(({ destinationWalletId, percent }) => ({
        destinationWalletId,
        percent,
      })),
    )
  })
}
