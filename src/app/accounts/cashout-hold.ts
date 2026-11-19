import { checkedToAccountId } from "@domain/accounts"
import { baseLogger } from "@services/logger"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { AccountsRepository } from "@services/mongoose"

/**
 * Cash-out holds (ENG-889). A hold on an account makes CashoutManager refuse to
 * create or execute a cash-out offer for it, with a message that never says
 * why. The Bridge customer status watcher places one when Bridge restricts
 * deposits for, or offboards, the account's Bridge customer. Nothing releases
 * a hold by itself: ops release it with the admin accountReleaseCashoutHold
 * mutation once they have looked at the account.
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
