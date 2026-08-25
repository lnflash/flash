import { checkedToAccountId } from "@domain/accounts"
import { AccountsRepository } from "@services/mongoose"

/**
 * The escape hatch for `setNpub`'s refusal. `userUpdateNpub` takes a bare npub
 * from any authenticated account with no proof of key control, so anyone can
 * read a victim's npub off a public relay and claim it first. The unique index
 * then makes that permanent: the rightful owner gets `NpubNotAvailableError`
 * forever, and the support desk resolves their DMs to the squatter's contact
 * card. Support needs to be able to free the key from the admin panel rather
 * than hand-writing an `$unset` against prod mongo.
 *
 * Releasing is deliberately not reassigning: the key goes back to unclaimed and
 * whoever actually holds the secret re-links from the app.
 */
export const releaseNpub = async (id: string): Promise<Account | ApplicationError> => {
  const accountsRepo = AccountsRepository()

  const idChecked = checkedToAccountId(id)
  if (idChecked instanceof Error) return idChecked

  return accountsRepo.unsetNpub(idChecked)
}
