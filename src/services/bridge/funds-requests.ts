/**
 * Bridge funds requests (sender-bank recalls), ENG-889.
 *
 * When a sender's bank recalls a fiat deposit, Bridge records a "funds
 * request" tied to the deposit and sends NO webhook, so this watcher polls
 * GET /v0/funds_requests from an hourly cron Job
 * (src/servers/bridge-funds-requests-cron.ts). For every funds request it has not
 * handled before it:
 *   - pages ops (critical),
 *   - notes the recall on the deposit's ERPNext Bridge Transfer Request row,
 *   - and, when Bridge flags the recall as fraud, locks the Flash account.
 *
 * Handled ids live in the `bridgefundsrequests` collection so restarts never
 * re-alert. Each step records its own outcome, so a step that failed (ERPNext
 * down, Mongo fault on the account lookup) is retried on the next run without
 * paging again. The page itself is a step too (`alertedAt`): a run that dies
 * after storing the request but before paging pages on the next run.
 *
 * https://apidocs.bridge.xyz/platform/orchestration/more/funds-requests
 */

import { updateAccountStatus } from "@app/accounts/update-account-status"
import { AccountStatus } from "@domain/accounts"
import { CouldNotFindError } from "@domain/errors"
import { toBridgeCustomerId } from "@domain/primitives/bridge"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { recordBridgeDepositRecall } from "@services/frappe/BridgeTransferRequestWriter"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose/accounts"
import {
  recordFundsRequestSeen,
  updateFundsRequestProgress,
} from "@services/mongoose/bridge-funds-request"

import BridgeApiClient, { FundsRequest } from "./client"
import { RECALL_NOTE_PREFIX } from "./deposit-states"
import { isBridgeNotAllowedError } from "./errors"

const logger = baseLogger.child({ module: "bridge-funds-requests" })

// Bridge's notice_date is the day its bank partner told it about the recall,
// so a new funds request carries a recent one. 30 days keeps every run's scan
// small while leaving room for Bridge to post a request days after the notice.
export const FUNDS_REQUEST_LOOKBACK_DAYS = 30
const PAGE_SIZE = 100
// Hard stop on a runaway cursor: 2,000 recalls in 30 days would itself be the
// incident.
const MAX_PAGES = 20

// Lock outcomes that end the lock step. Anything else is retried next run.
const FINAL_LOCK_OUTCOMES = new Set([
  "locked",
  "already_locked",
  "account_closed",
  "account_not_found",
])

// ERPNext outcomes that end the note step. "row_not_found" is retried: the
// deposit row may be written later (or by a Bridge webhook retry).
const FINAL_ERPNEXT_OUTCOMES = new Set(["updated", "already_recorded", "no_deposit_id"])

export type FundsRequestWatchSummary = {
  fetched: number
  newRequests: number
  locked: number
  erpnextRecorded: number
  failures: number
  pollFailed: boolean
  // Bridge refused GET /funds_requests for this API key (401 not_allowed), so
  // recalls were not watched this run. Not a failure: Bridge has declined to
  // grant the permission. If it ever does, the next run polls as normal.
  notPermitted: boolean
}

export const fundsRequestLockComment = (fr: Pick<FundsRequest, "id" | "deposit_id">) =>
  `Bridge funds request ${fr.id}: fraud recall of deposit ${fr.deposit_id ?? "unknown"}`

export const fundsRequestRecallNote = (fr: FundsRequest) =>
  [
    `${RECALL_NOTE_PREFIX} Bridge funds request ${fr.id}`,
    fr.fraud ? "fraud" : "not fraud",
    fr.notice_date ? `notice ${fr.notice_date}` : undefined,
  ]
    .filter(Boolean)
    .join(", ")

const toNoticeDate = (date: Date): string => date.toISOString().slice(0, 10)

const fetchRecentFundsRequests = async (now: Date): Promise<FundsRequest[] | Error> => {
  const since = new Date(
    now.getTime() - FUNDS_REQUEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  )
  const all: FundsRequest[] = []
  let startingAfter: string | undefined

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await BridgeApiClient.listFundsRequests({
        limit: PAGE_SIZE,
        startingAfter,
        noticeDateStartingOn: toNoticeDate(since),
      })
      all.push(...response.data)

      const last = response.data[response.data.length - 1]
      if (response.data.length < PAGE_SIZE || !last?.id) return all
      startingAfter = last.id
    }
    logger.warn(
      { pages: MAX_PAGES, fetched: all.length },
      "Bridge funds request poll hit its page cap; older requests not read this run",
    )
    return all
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

type AccountLookup =
  | { kind: "found"; account: Account }
  | { kind: "not_found" }
  | { kind: "lookup_failed"; error: Error }

const findAccount = async (customerId?: string): Promise<AccountLookup> => {
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

// Idempotent: an account already locked (or closed, which is stricter) is left
// as it is, so a retried run never stacks status history entries.
const lockForFraudRecall = async (
  lookup: AccountLookup,
  fr: FundsRequest,
): Promise<string> => {
  if (lookup.kind === "not_found") return "account_not_found"
  if (lookup.kind === "lookup_failed") return "lookup_failed"

  const { account } = lookup
  if (account.status === AccountStatus.Locked) return "already_locked"
  if (account.status === AccountStatus.Closed) return "account_closed"

  try {
    const updated = await updateAccountStatus({
      id: account.id,
      status: AccountStatus.Locked,
      comment: fundsRequestLockComment(fr),
    })
    if (updated instanceof Error) {
      logger.error(
        { error: updated, accountId: account.id, fundsRequestId: fr.id },
        "Failed to lock account for Bridge fraud recall",
      )
      return "lock_failed"
    }
    return "locked"
  } catch (error) {
    logger.error(
      { error, accountId: account.id, fundsRequestId: fr.id },
      "Locking account for Bridge fraud recall threw",
    )
    return "lock_failed"
  }
}

const noteOnDepositRow = async (fr: FundsRequest): Promise<string> => {
  if (!fr.deposit_id) return "no_deposit_id"
  try {
    const result = await recordBridgeDepositRecall({
      depositId: fr.deposit_id,
      note: fundsRequestRecallNote(fr),
    })
    if (result instanceof Error) {
      logger.error(
        { error: result, fundsRequestId: fr.id, depositId: fr.deposit_id },
        "Failed to note Bridge recall on the ERPNext deposit row",
      )
      return "erpnext_failed"
    }
    return result === "not_found" ? "row_not_found" : result
  } catch (error) {
    logger.error(
      { error, fundsRequestId: fr.id, depositId: fr.deposit_id },
      "Noting Bridge recall on the ERPNext deposit row threw",
    )
    return "erpnext_failed"
  }
}

const describeLock = (fraud: boolean, lockOutcome?: string): string => {
  if (!fraud) return "Not flagged as fraud, so the account was not locked."
  switch (lockOutcome) {
    case "locked":
      return "Flagged as fraud: the Flash account is now LOCKED."
    case "already_locked":
      return "Flagged as fraud: the Flash account was already locked."
    case "account_closed":
      return "Flagged as fraud: the Flash account is closed, left as is."
    case "account_not_found":
      return "Flagged as fraud, but no Flash account has this Bridge customer id. Nothing was locked."
    default:
      return "Flagged as fraud, but locking the Flash account FAILED. The next run retries; lock it by hand if this persists."
  }
}

const alertNewFundsRequest = ({
  fr,
  accountId,
  erpnextOutcome,
  lockOutcome,
}: {
  fr: FundsRequest
  accountId?: string
  erpnextOutcome: string
  lockOutcome?: string
}) => {
  const fraud = fr.fraud === true
  const amountText = `${fr.amount ?? "?"} ${(fr.currency ?? "usd").toUpperCase()}`
  alertBridge({
    dedupKey: generateDedupKey.bridgeFundsRequest(fr.id),
    source: "bridge-funds-request",
    severity: "critical",
    title: `Bridge deposit recalled by sender's bank${fraud ? " (FRAUD)" : ""}: ${amountText}`,
    detail: [
      `Funds request ${fr.id} recalls deposit ${fr.deposit_id ?? "unknown"}.`,
      describeLock(fraud, lockOutcome),
      "If the USDT was already delivered, Bridge may need a return through its fiat deposit return API.",
    ].join(" "),
    context: {
      funds_request_id: fr.id,
      deposit_id: fr.deposit_id,
      customer_id: fr.customer_id,
      account_id: accountId,
      amount: fr.amount,
      currency: fr.currency,
      payment_rail: fr.payment_rail,
      fraud,
      notice_date: fr.notice_date,
      imad: fr.imad,
      trace_number: fr.trace_number,
      deposit_created_at: fr.deposit_created_at,
      erpnext_row: erpnextOutcome,
      lock: lockOutcome,
    },
  })
}

const handleFundsRequest = async (
  fr: FundsRequest,
  summary: FundsRequestWatchSummary,
): Promise<void> => {
  const fraud = fr.fraud === true
  const seen = await recordFundsRequestSeen({
    fundsRequestId: fr.id,
    depositId: fr.deposit_id,
    customerId: fr.customer_id,
    amount: fr.amount,
    currency: fr.currency,
    paymentRail: fr.payment_rail,
    fraud,
    noticeDate: fr.notice_date,
    raw: fr,
  })
  if (seen instanceof Error) {
    // Without the record a page could repeat every run, so nothing else is
    // done for this request until it can be stored.
    logger.error(
      { error: seen, fundsRequestId: fr.id },
      "Failed to store Bridge funds request; skipping it this run",
    )
    summary.failures++
    return
  }

  const { inserted, record } = seen
  const alertPending = !record.alertedAt
  const erpnextPending = !record.erpnextRecordedAt
  const lockPending = fraud && !record.lockDoneAt
  if (!alertPending && !erpnextPending && !lockPending) return

  if (inserted) summary.newRequests++

  const lookup =
    alertPending || lockPending ? await findAccount(fr.customer_id) : undefined
  const accountId =
    lookup?.kind === "found" ? (lookup.account.id as string) : record.accountId

  let erpnextOutcome = record.erpnextOutcome ?? "pending"
  let erpnextRecordedAt: Date | undefined
  if (erpnextPending) {
    erpnextOutcome = await noteOnDepositRow(fr)
    if (FINAL_ERPNEXT_OUTCOMES.has(erpnextOutcome)) {
      erpnextRecordedAt = new Date()
      summary.erpnextRecorded++
    } else {
      summary.failures++
    }
  }

  let lockOutcome = record.lockOutcome
  let lockDoneAt: Date | undefined
  let lockedThisRun = false
  if (lockPending && lookup) {
    lockOutcome = await lockForFraudRecall(lookup, fr)
    if (FINAL_LOCK_OUTCOMES.has(lockOutcome)) lockDoneAt = new Date()
    else summary.failures++
    if (lockOutcome === "locked") {
      summary.locked++
      lockedThisRun = true
    }
  }

  // Page before the progress write that records it, so a crash in between
  // repeats the page (PagerDuty folds it into the same incident by dedup key)
  // instead of losing it. The cron entrypoint flushes in-flight alerts before it
  // exits.
  let alertedAt: Date | undefined
  if (alertPending) {
    alertNewFundsRequest({ fr, accountId, erpnextOutcome, lockOutcome })
    alertedAt = new Date()
  } else if (lockedThisRun) {
    // The first page said the lock failed; tell ops it has now happened.
    alertBridge({
      dedupKey: `${generateDedupKey.bridgeFundsRequest(fr.id)}:locked-on-retry`,
      source: "bridge-funds-request",
      severity: "warning",
      title: `Account locked on retry for Bridge fraud recall ${fr.id}`,
      detail: fundsRequestLockComment(fr),
      context: {
        funds_request_id: fr.id,
        deposit_id: fr.deposit_id,
        account_id: accountId,
      },
    })
  }

  const progress = await updateFundsRequestProgress(fr.id, {
    accountId,
    erpnextOutcome,
    ...(erpnextRecordedAt ? { erpnextRecordedAt } : {}),
    ...(lockOutcome ? { lockOutcome } : {}),
    ...(lockDoneAt ? { lockDoneAt } : {}),
    ...(alertedAt ? { alertedAt } : {}),
  })
  if (progress instanceof Error) {
    logger.error(
      { error: progress, fundsRequestId: fr.id },
      "Failed to store Bridge funds request progress; steps will be retried",
    )
    summary.failures++
  }

  logger.info(
    {
      fundsRequestId: fr.id,
      depositId: fr.deposit_id,
      customerId: fr.customer_id,
      accountId,
      fraud,
      inserted,
      paged: alertPending,
      erpnextOutcome,
      lockOutcome,
    },
    "Bridge funds request handled",
  )
}

export const watchBridgeFundsRequests = async ({
  now = new Date(),
}: { now?: Date } = {}): Promise<FundsRequestWatchSummary> => {
  const summary: FundsRequestWatchSummary = {
    fetched: 0,
    newRequests: 0,
    locked: 0,
    erpnextRecorded: 0,
    failures: 0,
    pollFailed: false,
    notPermitted: false,
  }

  const fundsRequests = await fetchRecentFundsRequests(now)
  if (isBridgeNotAllowedError(fundsRequests)) {
    logger.warn(
      { status: fundsRequests.statusCode, code: fundsRequests.code },
      "Bridge funds requests not permitted for this API key; recall watch skipped",
    )
    return { ...summary, notPermitted: true }
  }
  if (fundsRequests instanceof Error) {
    // Bridge outages (5xx, timeouts) already page from the client. This one is
    // for the rest (other 4xx, a revoked key): recalls go unseen until it is
    // fixed. A key that simply lacks the permission is handled above.
    logger.error({ error: fundsRequests }, "Bridge funds request poll failed")
    alertBridge({
      dedupKey: generateDedupKey.bridgeFundsRequestPollFailed(),
      source: "bridge-funds-request",
      severity: "warning",
      title: "Bridge funds request poll failed: wire recalls are not being watched",
      detail: fundsRequests.message,
    })
    return { ...summary, pollFailed: true }
  }

  summary.fetched = fundsRequests.length
  for (const fr of fundsRequests) {
    if (!fr?.id) continue
    try {
      await handleFundsRequest(fr, summary)
    } catch (error) {
      logger.error({ error, fundsRequestId: fr.id }, "Bridge funds request handler threw")
      summary.failures++
    }
  }

  return summary
}
