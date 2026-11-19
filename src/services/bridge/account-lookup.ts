import { CouldNotFindError } from "@domain/errors"
import { toBridgeCustomerId } from "@domain/primitives/bridge"
import { AccountsRepository } from "@services/mongoose/accounts"

// The Flash account mapped to a Bridge customer id (ENG-889). One lookup for
// the Bridge pollers and webhook routes, so a change to it (an index, error
// mapping) reaches every caller. Never throws: a Mongo fault is
// "lookup_failed", which callers treat as retryable; no customer id at all is
// "not_found".
export type AccountLookup =
  | { kind: "found"; account: Account }
  | { kind: "not_found" }
  | { kind: "lookup_failed"; error: Error }

export const findAccountByBridgeCustomerId = async (
  customerId?: string,
): Promise<AccountLookup> => {
  if (!customerId) return { kind: "not_found" }
  try {
    const account = await AccountsRepository().findByBridgeCustomerId(
      toBridgeCustomerId(customerId),
    )
    if (account instanceof CouldNotFindError) return { kind: "not_found" }
    if (account instanceof Error) return { kind: "lookup_failed", error: account }
    return { kind: "found", account }
  } catch (error) {
    return {
      kind: "lookup_failed",
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}
