import { checkedToAccountId } from "@domain/accounts"
import {
  CouldNotFindAccountFromIdError,
  CouldNotFindError,
  DuplicateKeyForPersistError,
  NoNpubToReleaseError,
} from "@domain/errors"
import { AccountAlreadyHasNpubError, NpubNotAvailableError } from "@domain/nostr"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"

export type NpubRelease = {
  account: Account
  previousNpub: Npub
  reassignedTo?: Account
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
 * reassignment fail with `NpubNotAvailableError` — the release still stands, so
 * the operator must retry the reassignment rather than assume it applied. The
 * target is read and checked before the release so that everything knowable up
 * front fails before the key is freed; the unique partial index is what
 * guarantees the reassignment cannot collide.
 *
 * `releasedByUserId` is the whole attribution trail. Neither the account
 * document nor the payload retains the npub that was removed, and the admin
 * server never assigns `req.gqlContext`, so the Pino request log records the
 * actor as undefined — the structured log line below is the only record that a
 * given admin took a given key off a given account.
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

  const idChecked = checkedToAccountId(id)
  if (idChecked instanceof Error) return idChecked

  const targetIdChecked =
    reassignToAccountId === undefined
      ? undefined
      : checkedToAccountId(reassignToAccountId)
  if (targetIdChecked instanceof Error) return targetIdChecked

  const holder = await accountsRepo.findById(idChecked)
  if (holder instanceof CouldNotFindError) {
    return new CouldNotFindAccountFromIdError(idChecked)
  }
  if (holder instanceof Error) return holder

  const previousNpub = holder.npub
  if (previousNpub === undefined) return new NoNpubToReleaseError(idChecked)

  let target: Account | undefined
  if (targetIdChecked !== undefined) {
    const found = await accountsRepo.findById(targetIdChecked)
    if (found instanceof CouldNotFindError) {
      return new CouldNotFindAccountFromIdError(targetIdChecked)
    }
    if (found instanceof Error) return found
    // Also catches `reassignToAccountId === id`, where the target is the holder
    // and there is nothing to move.
    if (found.npub !== undefined) return new AccountAlreadyHasNpubError(targetIdChecked)
    target = found
  }

  const released = await accountsRepo.unsetNpub(idChecked)
  if (released instanceof Error) return released

  baseLogger.info(
    {
      accountId: idChecked,
      previousNpub,
      releasedByUserId,
      reassignedToAccountId: targetIdChecked,
    },
    "admin released an npub claim",
  )

  if (target === undefined) return { account: released, previousNpub }

  const reassigned = await accountsRepo.claimNpub(target.id, previousNpub)
  if (reassigned instanceof DuplicateKeyForPersistError) {
    return new NpubNotAvailableError(previousNpub)
  }
  if (reassigned instanceof Error) return reassigned

  return { account: released, previousNpub, reassignedTo: reassigned }
}
