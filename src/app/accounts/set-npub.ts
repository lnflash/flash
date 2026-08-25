import { checkedToNpub, NpubNotAvailableError } from "@domain/nostr"
import { CouldNotFindError } from "@domain/errors"
import { AccountsRepository } from "@services/mongoose"

export const setNpub = async ({
  id,
  npub,
}: {
  id: AccountId
  npub: Npub
}): Promise<Account | ApplicationError> => {
  const accountsRepo = AccountsRepository()

  const npubChecked = checkedToNpub(npub)
  if (npubChecked instanceof Error) return npubChecked

  // An npub is an identity, and since this PR it is also a support-desk
  // lookup key: `findByNpub` is a `findOne`, so two accounts claiming the same
  // npub would resolve nondeterministically and could paint one customer's
  // phone/email/level onto another's contact card. Refuse the claim here, and
  // let the unique index on `accounts.npub` catch the concurrent-write race.
  const existing = await accountsRepo.findByNpub(npubChecked)
  if (!(existing instanceof Error)) {
    if (existing.id !== id) return new NpubNotAvailableError(npubChecked)
    return existing
  }
  if (!(existing instanceof CouldNotFindError)) return existing

  const account = await accountsRepo.findById(id)
  if (account instanceof Error) return account
  account.npub = npubChecked
  return accountsRepo.update(account)
}
