import { checkedToAccountId } from "@domain/accounts"
import {
  CouldNotFindAccountFromIdError,
  CouldNotFindError,
  DuplicateKeyForPersistError,
} from "@domain/errors"
import { AccountAlreadyHasNpubError, NpubNotAvailableError } from "@domain/nostr"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"

export type NpubRelease = {
  account: Account
  previousNpub: Npub
  reassignedTo?: Account
  // Set when the release landed and the claim meant to follow it did not. This
  // is not an alternative to the release: the key is off the holder either way,
  // and re-running the mutation now fails with `NoNpubToReleaseError`.
  reassignmentError?: ApplicationError
}

/**
 * The escape hatch for `setNpub`'s refusal. `userUpdateNpub` takes a bare npub
 * from any authenticated account with no proof of key control, so anyone can
 * read a victim's npub off a public relay and claim it first. The unique index
 * then makes that permanent: the rightful owner gets `NpubNotAvailableError`
 * forever, and the support desk resolves their DMs to the squatter's contact
 * card. Support needs to be able to free the key from the admin panel rather
 * than hand-writing an `$unset` against prod mongo.
 *
 * A bare release loses the race it exists to win: the squatter is the party
 * polling `isFlashNpub`, so telling the victim to go re-link pits a human
 * against a script. `reassignToAccountId` closes that by handing the key
 * straight to the rightful owner. This repository has no MongoDB sessions
 * anywhere, so the two writes are not a transaction: the key is unclaimed for
 * the round-trip between them, and a claim that lands in that window makes the
 * reassignment fail with `NpubNotAvailableError`. The release still stands, so
 * that failure comes back as `reassignmentError` on an otherwise populated
 * `NpubRelease` rather than as a bare error — a bare error reads as "nothing
 * happened", and the operator would neither know the key is now unclaimed nor
 * that recovering it means finding its current holder with
 * `accountDetailsByNpub` and releasing it from there. The target is read and
 * checked before the release so that everything knowable up front fails before
 * the key is freed; the unique partial index guarantees the reassignment
 * cannot collide with a concurrent claim of the same key, and `claimNpub`'s
 * own write-time filter refuses a target that linked a different key after the
 * pre-release check — surfaced as `AccountAlreadyHasNpubError` in
 * `reassignmentError`, never a silent overwrite of the target's key.
 *
 * `releasedByUserId` is the whole attribution trail. Neither the account
 * document nor the payload retains the npub that was removed, and the admin
 * server never assigns `req.gqlContext`, so the Pino request log records the
 * actor as undefined — the structured log lines below are the only record that
 * a given admin took a given key off a given account. Refusals are logged for
 * the same reason: a stolen admin token sweeping account ids leaves one line
 * for the release that worked and, without them, nothing at all for the probes
 * that did not.
 */
export const releaseNpub = async ({
  id,
  releasedByUserId,
  reassignToAccountId,
}: {
  id: string
  releasedByUserId: UserId
  reassignToAccountId?: string
}): Promise<NpubRelease | ApplicationError> => {
  const accountsRepo = AccountsRepository()

  const refuse = <E extends ApplicationError>(reason: string, error: E): E => {
    baseLogger.warn(
      { accountId: id, releasedByUserId, reassignToAccountId, reason },
      "admin npub release refused",
    )
    return error
  }

  const idChecked = checkedToAccountId(id)
  if (idChecked instanceof Error) return refuse("malformed account id", idChecked)

  const targetIdChecked =
    reassignToAccountId === undefined
      ? undefined
      : checkedToAccountId(reassignToAccountId)
  if (targetIdChecked instanceof Error) {
    return refuse("malformed reassignment target id", targetIdChecked)
  }

  let target: Account | undefined
  if (targetIdChecked !== undefined) {
    const found = await accountsRepo.findById(targetIdChecked)
    if (found instanceof CouldNotFindError) {
      return refuse(
        "unknown reassignment target",
        new CouldNotFindAccountFromIdError(targetIdChecked),
      )
    }
    if (found instanceof Error) return found
    // Also catches `reassignToAccountId === id`, where the target is the holder
    // and there is nothing to move.
    //
    // `typeof` rather than `!== undefined`: the field is `Npub | null` on the
    // record and the migration deliberately leaves pre-existing `npub: null`
    // documents alone, so an account that has never linked a key can arrive
    // here holding an explicit null. That is not a claim, and treating it as
    // one would make such an account permanently ineligible to receive one.
    if (typeof found.npub === "string") {
      return refuse(
        "reassignment target already holds an npub",
        new AccountAlreadyHasNpubError(targetIdChecked),
      )
    }
    target = found
  }

  // The holder's existence and its npub are both established by `unsetNpub`
  // off the pre-update document, so this branch carries the refusals that a
  // separate holder read used to make here — plus genuine write failures.
  const released = await accountsRepo.unsetNpub(idChecked)
  if (released instanceof Error) return refuse(released.name, released)

  const { account, previousNpub } = released

  baseLogger.info(
    {
      accountId: idChecked,
      previousNpub,
      releasedByUserId,
      // Intent, not outcome. The claim has not been attempted yet and can still
      // lose to a concurrent one; an investigator reading this line must not
      // conclude the key reached the target.
      reassignToAccountId: targetIdChecked,
    },
    "admin released an npub claim",
  )

  if (target === undefined) return { account, previousNpub }

  const reassigned = await accountsRepo.claimNpub(target.id, previousNpub)
  if (reassigned instanceof Error) {
    baseLogger.error(
      {
        accountId: idChecked,
        previousNpub,
        reassignToAccountId: targetIdChecked,
        releasedByUserId,
        // Which failure, not just that one happened. Three distinct causes
        // reach this branch and each has a different recovery, so a line that
        // does not name the cause hands the operator all three procedures at
        // once.
        //
        // What is true for ALL of them: the release already landed, so this
        // account no longer holds the key and `accountReleaseNpub` cannot be
        // re-run against it — it answers `NoNpubToReleaseError`. Recovery is
        // `accountAssignNpub(accountId, npub)`, which is the second write on
        // its own and carries the same two guards (unique index, write-time
        // refusal of a target that already holds a key).
        //
        // `DuplicateKeyForPersistError` (surfaced to the caller as
        // `NpubNotAvailableError`): someone else claimed the key in the window
        // between the two writes — it is gone, so assignment will refuse too;
        // find the new holder with `accountDetailsByNpub` and release it from
        // there first.
        // `AccountAlreadyHasNpubError`: the target linked a different key
        // after the pre-release check — the released key is still unclaimed,
        // so assign it to the right account before anyone polling
        // `isFlashNpub` takes it.
        // Anything else (e.g. `UnknownRepositoryError`): the write failed and
        // the key is unclaimed — assign it to the intended target.
        //
        // Taken off the raw repository error, before the
        // `DuplicateKeyForPersistError` → `NpubNotAvailableError` mapping
        // below, so the line names the failure that actually happened.
        reason: reassigned.name,
        reassignmentError: reassigned.message,
      },
      "npub released but reassignment failed",
    )
    return {
      account,
      previousNpub,
      reassignmentError:
        reassigned instanceof DuplicateKeyForPersistError
          ? new NpubNotAvailableError(previousNpub)
          : reassigned,
    }
  }

  baseLogger.info(
    {
      accountId: idChecked,
      previousNpub,
      releasedByUserId,
      reassignedToAccountId: target.id,
    },
    "admin reassigned a released npub",
  )

  return { account, previousNpub, reassignedTo: reassigned }
}
