import { checkedToNpub, NpubNotAvailableError } from "@domain/nostr"
import { CouldNotFindError, DuplicateKeyForPersistError } from "@domain/errors"
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

  const updated = await accountsRepo.update(account)
  // The probe above and this write are not atomic, so two concurrent claims on
  // the same npub can both pass it. The loser's write trips the unique index,
  // which `parseRepositoryError` surfaces as `DuplicateKeyForPersistError` —
  // an error `error-map` buckets into `UnexpectedClientError` ("please contact
  // support"). It is not unexpected: it is the same refusal as the probe, and
  // the caller deserves the same answer.
  if (updated instanceof DuplicateKeyForPersistError) {
    return new NpubNotAvailableError(npubChecked)
  }
  return updated
}
