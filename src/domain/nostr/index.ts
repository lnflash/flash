import { InvalidNpubError } from "./errors"

export * from "./errors"

export const checkValidNpub = (npub: string): boolean => {
  return npub.startsWith("npub1") && npub.length === 63
}

// Mirrors `checkedToUsername` / `checkedToAccountUuid`: the branded `Npub` type
// only means something if there is a single place that mints it. Callers that
// are not the GraphQL boundary (scripts, backfills, REST shims) get a
// validation error instead of a silent not-found on a malformed value.
export const checkedToNpub = (npub: string): Npub | ValidationError => {
  if (!checkValidNpub(npub)) return new InvalidNpubError(npub)
  return npub.toLowerCase() as Npub
}
