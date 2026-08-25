import { checkedToNpub } from "@domain/nostr"
import { AccountsRepository } from "@services/mongoose"

/**
 * Also re-exported as `Admin.getAccountByNpub` — one implementation, two
 * barrels, so fixes cannot drift between them. Normalised because the
 * repository query is a plain `$eq` with no collation, so a caller that is not
 * the GraphQL boundary (a script, a backfill, a REST shim) passing a mixed-case
 * npub gets a silent not-found on a real user — which the public
 * `isFlashNpub` query reports as `isFlashNpub: false`.
 *
 * Lives outside `index.ts` so it can be unit tested against a mocked
 * repository — importing the accounts barrel drags in the notification stack.
 */
export const findByNpub = async (npub: Npub): Promise<Account | ApplicationError> => {
  const npubChecked = checkedToNpub(npub)
  if (npubChecked instanceof Error) return npubChecked

  const accounts = AccountsRepository()
  return accounts.findByNpub(npubChecked)
}
