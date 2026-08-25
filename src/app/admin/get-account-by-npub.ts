import { checkedToNpub } from "@domain/nostr"
import { AccountsRepository } from "@services/mongoose"

/**
 * Lives in its own module rather than inline in `index.ts` so it can be unit
 * tested against a mocked repository — importing the admin barrel drags in the
 * notification and invite stacks, which open connections at import time.
 */
export const getAccountByNpub = async (npub: Npub) => {
  // Mirrors getAccountByUsername: the branded type is the contract, and
  // checkedToNpub is defence in depth for callers that are not the GraphQL
  // boundary (scripts, backfills, a future REST shim) — they get a validation
  // error rather than a silent not-found on a malformed value.
  const npubValid = checkedToNpub(npub)
  if (npubValid instanceof Error) return npubValid

  const accounts = AccountsRepository()
  return accounts.findByNpub(npubValid)
}
