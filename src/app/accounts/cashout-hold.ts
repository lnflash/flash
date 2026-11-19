import { checkedToAccountId } from "@domain/accounts"
import { baseLogger } from "@services/logger"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { AccountsRepository } from "@services/mongoose"

/**
 * Cash-out holds (ENG-889). A hold on an account makes CashoutManager refuse to
 * create or execute a cash-out offer for it, with a message that never says
 * why. The Bridge customer status watcher places one when Bridge restricts
 * deposits for, or offboards, the account's Bridge customer; ops place one by
 * hand with the admin accountPlaceCashoutHold mutation (for example on a
 * customer the watcher's first run listed as already restricted). Nothing
 * releases a hold by itself: ops release it with the admin
 * accountReleaseCashoutHold mutation once they have looked at the account.
 */

export const placeCashoutHold = async ({
  accountId,
  reason,
  source,
  setByUserId,
}: {
  accountId: AccountId
  reason: string
  source: string
  setByUserId?: UserId
}): Promise<CashoutHoldPlaced | ApplicationError> =>
  AccountsRepository().placeCashoutHold(accountId, {
    reason,
    source,
    setAt: new Date(),
    ...(setByUserId ? { setByUserId } : {}),
  })

export const ADMIN_CASHOUT_HOLD_SOURCE = "admin"

// An ops hold, attributed to the calling admin. An account that already has a
// hold keeps it untouched (`placed: false`), and the caller reports that hold.
export const placeCashoutHoldByAdmin = async ({
  id,
  reason,
  placedByUserId,
}: {
  id: string
  reason: string
  placedByUserId: UserId
}): Promise<CashoutHoldPlaced | ApplicationError> => {
  const accountId = checkedToAccountId(id)
  if (accountId instanceof Error) return accountId

  const placed = await placeCashoutHold({
    accountId,
    reason,
    source: ADMIN_CASHOUT_HOLD_SOURCE,
    setByUserId: placedByUserId,
  })
  if (placed instanceof Error) {
    baseLogger.warn(
      { accountId, placedByUserId, error: placed.name },
      "admin cash-out hold refused",
    )
    return placed
  }

  if (!placed.placed) {
    baseLogger.info(
      { accountId, placedByUserId, existingHold: placed.account.cashoutHold },
      "admin cash-out hold not placed: the account already has one",
    )
    return placed
  }

  // As for a release: this line and the account's cashoutHoldHistory are the
  // trail of who placed it.
  baseLogger.info({ accountId, placedByUserId, reason }, "admin placed cash-out hold")
  notifyOpsEvent({
    flow: "cashout",
    phase: "hold-placed",
    status: "pending",
    accountId,
    userId: placedByUserId,
    step: `held by ${ADMIN_CASHOUT_HOLD_SOURCE}`,
  })
  return placed
}

export const releaseCashoutHold = async ({
  id,
  releasedByUserId,
  comment,
}: {
  id: string
  releasedByUserId: UserId
  comment?: string
}): Promise<CashoutHoldReleased | ApplicationError> => {
  const accountId = checkedToAccountId(id)
  if (accountId instanceof Error) return accountId

  const released = await AccountsRepository().releaseCashoutHold(accountId, {
    releasedByUserId,
    comment,
  })
  if (released instanceof Error) {
    baseLogger.warn(
      { accountId, releasedByUserId, error: released.name },
      "admin cash-out hold release refused",
    )
    return released
  }

  // The admin server keeps no request-level record of the actor, so this line
  // and the account's cashoutHoldHistory are the trail of who released it.
  baseLogger.info(
    {
      accountId,
      releasedByUserId,
      comment,
      previousHold: released.previousHold,
    },
    "admin released cash-out hold",
  )
  notifyOpsEvent({
    flow: "cashout",
    phase: "hold-released",
    status: "success",
    accountId,
    userId: releasedByUserId,
    // `step` is shown whole; `meta` values are cut to 8 characters.
    step: `held by ${released.previousHold.source}`,
  })
  return released
}
