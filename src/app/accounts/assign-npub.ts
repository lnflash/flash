import { checkedToAccountId } from "@domain/accounts"
import { DuplicateKeyForPersistError } from "@domain/errors"
import { checkedToNpub, NpubNotAvailableError } from "@domain/nostr"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"

/**
 * The other half of `releaseNpub`'s reassignment, reachable on its own.
 *
 * `releaseNpub` is two writes and no transaction: the unset lands, then the
 * claim. When the claim fails — mongo hiccups, or the target linked a key in
 * the window — the key is unclaimed and the account it was taken off no longer
 * holds it, so `accountReleaseNpub` cannot be re-run against that account: it
 * returns `NoNpubToReleaseError`. Before this existed the only remaining npub
 * write was `userUpdateNpub`, which is self-service and subject to the very
 * race the reassignment exists to win — the squatter is the party polling
 * `isFlashNpub`, so the desk's only advice was to pit a human against a script.
 * This makes the second write retryable by an admin.
 *
 * Safety comes from the same two mechanisms the reassignment already relies on,
 * not from new ones: the unique partial index refuses a key another account
 * holds (surfaced as `NpubNotAvailableError`), and `claimNpub`'s write-time
 * `$not: { $type: "string" }` filter refuses a target that already holds a key
 * (`AccountAlreadyHasNpubError`) rather than silently overwriting it. So this
 * can only ever fill a hole; it cannot take a key from anyone.
 *
 * `assignedByUserId` is the attribution trail, for the reason spelled out in
 * `release-npub.ts`: the admin server never assigns `req.gqlContext`, so these
 * structured lines are the only record of who moved a key. Refusals are logged
 * too — a stolen admin token sweeping ids should not be able to probe silently.
 */
export const assignNpub = async ({
  id,
  npub,
  assignedByUserId,
}: {
  id: string
  npub: string
  assignedByUserId: UserId
}): Promise<Account | ApplicationError> => {
  const idChecked = checkedToAccountId(id)
  if (idChecked instanceof Error) return idChecked

  const npubChecked = checkedToNpub(npub)
  if (npubChecked instanceof Error) return npubChecked

  const accountsRepo = AccountsRepository()

  const claimed = await accountsRepo.claimNpub(idChecked, npubChecked)
  if (claimed instanceof Error) {
    baseLogger.error(
      {
        accountId: idChecked,
        npub: npubChecked,
        assignedByUserId,
        reason: claimed.name,
        error: claimed.message,
      },
      "admin npub assignment refused",
    )
    // Same mapping the reassignment path uses, so one cause reads identically
    // wherever it surfaces: the key belongs to someone else.
    if (claimed instanceof DuplicateKeyForPersistError) {
      return new NpubNotAvailableError(npubChecked)
    }
    return claimed
  }

  baseLogger.info(
    { accountId: idChecked, npub: npubChecked, assignedByUserId },
    "admin assigned an npub claim",
  )

  return claimed
}
