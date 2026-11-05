import { RepositoryError } from "@domain/errors"

// A deliberate unresolved money state, distinct from an unavailable database.
export class BridgeWithdrawalCompletionProofRequiredError extends RepositoryError {
  constructor() {
    super("Withdrawal completion requires confirmed provider state")
  }
}
