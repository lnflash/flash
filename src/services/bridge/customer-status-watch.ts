/**
 * Bridge customer status watch (ENG-889).
 *
 * Bridge can pause, restrict deposits for, offboard or reject a customer at any
 * time, and Flash learned of it only when the customer's next Bridge call
 * failed. This watcher runs from the hourly Bridge Job
 * (src/servers/bridge-funds-requests-cron.ts): it lists every Bridge customer
 * (GET /v0/customers), compares each status with the last one it stored
 * (`bridgecustomerstatuses`), and on a change:
 *   - into paused or rejected: alerts ops (warning);
 *   - into deposits_restricted or offboarded: alerts ops (critical, pages) and
 *     puts a cash-out hold on the mapped Flash account;
 *   - from one of those back to active: informs ops. A hold stays until ops
 *     release it (admin accountReleaseCashoutHold).
 *
 * Until a baseline has been fully recorded (the store's baseline marker), a run
 * records every status without alerting, and reports how many customers are
 * already in a risky status, so ops know the baseline. A seed that failed part
 * way is simply run again: it is insert-if-absent, so nothing already recorded
 * is overwritten, and no customer the failed seed missed is alerted or held. After that, a customer seen for the first time counts as a
 * change from nothing: one that appears already restricted is alerted (and
 * held) like any other.
 *
 * A change whose cash-out hold could not be placed (account lookup or write
 * failed) is not recorded, so the next run sees it again and retries.
 *
 * https://apidocs.bridge.xyz/platform/customers/customers/api
 */

import { placeCashoutHold } from "@app/accounts/cashout-hold"
import { CouldNotFindError } from "@domain/errors"
import { AlertSeverity, alertBridge, generateDedupKey } from "@services/alerts"
import { OpsStatus, notifyOpsEvent } from "@services/alerts/ops-events"
import { baseLogger } from "@services/logger"
import {
  BridgeCustomerStatusRecord,
  loadCustomerStatuses,
  recordCustomerStatusChange,
  seedCustomerStatuses,
} from "@services/mongoose/bridge-customer-status"

import { AccountLookup, findAccountByBridgeCustomerId } from "./account-lookup"
import BridgeApiClient, { Customer } from "./client"
import { paginateNewestFirst } from "./paginate"

const logger = baseLogger.child({ module: "bridge-customer-status-watch" })

const PAGE_SIZE = 100
// 50,000 customers. Past it the run works on the customers it read and says so.
const MAX_PAGES = 500

export const CASHOUT_HOLD_SOURCE = "bridge-customer-status"

// Statuses that alert ops on the way in, and how loudly.
export const RISKY_STATUS_SEVERITY: Readonly<Record<string, AlertSeverity>> = {
  deposits_restricted: "critical",
  offboarded: "critical",
  paused: "warning",
  rejected: "warning",
}

// Statuses that put a cash-out hold on the mapped Flash account.
export const CASHOUT_HOLD_STATUSES: ReadonlySet<string> = new Set([
  "deposits_restricted",
  "offboarded",
])

const isRisky = (status?: string): boolean =>
  status !== undefined &&
  Object.prototype.hasOwnProperty.call(RISKY_STATUS_SEVERITY, status)

export type CustomerStatusWatchSummary = {
  fetched: number
  // True on the run that recorded the baseline.
  seeded: boolean
  // Baseline run only: customers already in each risky status.
  baselineRisky: Record<string, number>
  changes: number
  alerts: number
  holdsPlaced: number
  failures: number
  // Bridge could not be read, or the store could not be read or seeded. The
  // run did nothing, so the Job fails.
  pollFailed: boolean
}

const STATUS_MEANING: Record<string, string> = {
  deposits_restricted:
    "Bridge restricted deposits: new deposits to this customer are returned to the sender.",
  offboarded: "Bridge offboarded the customer: the Bridge account is permanently closed.",
  paused: "Bridge paused the customer, under review for an account-related reason.",
  rejected: "Bridge rejected the customer.",
  active: "Bridge reports the customer active again.",
}

const fetchAllCustomers = async (): Promise<Customer[] | Error> =>
  paginateNewestFirst({
    fetchPage: ({ limit, startingAfter }) =>
      BridgeApiClient.listCustomers({ limit, startingAfter }),
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
    onPageCap: (fetched) =>
      logger.warn(
        { pages: MAX_PAGES, fetched },
        "Bridge customer list hit its page cap; the oldest customers were not read this run",
      ),
  })

// "placed" / "already_held" / "account_not_found" are final; "lookup_failed"
// and "hold_failed" are retried by the next run.
type HoldOutcome =
  | "placed"
  | "already_held"
  | "account_not_found"
  | "lookup_failed"
  | "hold_failed"

const FINAL_HOLD_OUTCOMES: ReadonlySet<HoldOutcome> = new Set([
  "placed",
  "already_held",
  "account_not_found",
])

export const cashoutHoldReason = (
  customerId: string,
  from: string | undefined,
  to: string,
) => `Bridge customer ${customerId} went from ${from ?? "unseen"} to ${to}`

const holdCashouts = async (
  lookup: AccountLookup,
  customerId: string,
  from: string | undefined,
  to: string,
): Promise<HoldOutcome> => {
  if (lookup.kind === "not_found") return "account_not_found"
  if (lookup.kind === "lookup_failed") {
    logger.error(
      { error: lookup.error, customerId },
      "Account lookup failed; cash-out hold not placed",
    )
    return "lookup_failed"
  }
  try {
    const result = await placeCashoutHold({
      accountId: lookup.account.id,
      reason: cashoutHoldReason(customerId, from, to),
      source: CASHOUT_HOLD_SOURCE,
    })
    if (result instanceof CouldNotFindError) return "account_not_found"
    if (result instanceof Error) {
      logger.error(
        { error: result, customerId, accountId: lookup.account.id },
        "Failed to place cash-out hold",
      )
      return "hold_failed"
    }
    return result.placed ? "placed" : "already_held"
  } catch (error) {
    logger.error(
      { error, customerId, accountId: lookup.account.id },
      "Placing cash-out hold threw",
    )
    return "hold_failed"
  }
}

const describeHold = (outcome?: HoldOutcome): string | undefined => {
  switch (outcome) {
    case undefined:
      return undefined
    case "placed":
      return "Cash-outs are now HELD for the Flash account. Release with accountReleaseCashoutHold after review."
    case "already_held":
      return "The Flash account already had a cash-out hold; it is kept."
    case "account_not_found":
      return "No Flash account has this Bridge customer id, so nothing was held."
    default:
      return "Placing the cash-out hold FAILED. The next run retries; hold the account by hand if this persists."
  }
}

const OPS_STATUS: Record<AlertSeverity, OpsStatus> = {
  critical: "failed",
  warning: "pending",
  info: "success",
}

const alertStatusChange = ({
  customerId,
  from,
  to,
  severity,
  lookup,
  holdOutcome,
}: {
  customerId: string
  from?: string
  to: string
  severity: AlertSeverity
  lookup: AccountLookup
  holdOutcome?: HoldOutcome
}) => {
  const account = lookup.kind === "found" ? lookup.account : undefined
  const who = account?.username ? `${account.username} (${customerId})` : customerId
  const heldNow = account?.cashoutHold
    ? "A cash-out hold is still on the Flash account; release it with accountReleaseCashoutHold if appropriate."
    : undefined

  alertBridge({
    dedupKey: generateDedupKey.bridgeCustomerStatus(customerId, to),
    source: "bridge-customer-status",
    severity,
    title: `Bridge customer ${to.replace(/_/g, " ")}: ${who}`,
    detail: [
      `Status went from ${from ?? "unseen"} to ${to}.`,
      STATUS_MEANING[to],
      to === "active" ? heldNow : describeHold(holdOutcome),
      lookup.kind === "not_found" && !holdOutcome
        ? "No Flash account has this Bridge customer id."
        : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    context: {
      customer_id: customerId,
      old_status: from ?? "unseen",
      new_status: to,
      account_id: account?.id,
      username: account?.username,
      account_lookup: lookup.kind,
      cashout_hold: holdOutcome,
    },
  })

  notifyOpsEvent({
    flow: "customer",
    phase: to.replace(/_/g, "-"),
    status: OPS_STATUS[severity],
    accountId: account?.id,
    step: `${from ?? "unseen"} to ${to}${holdOutcome ? `, cash-out hold: ${holdOutcome}` : ""}`,
    meta: {
      customer: customerId,
      ...(account?.username ? { username: account.username } : {}),
    },
  })
}

const handleChange = async (
  customerId: string,
  stored: BridgeCustomerStatusRecord | undefined,
  to: string,
  summary: CustomerStatusWatchSummary,
): Promise<void> => {
  const from = stored?.status
  const intoRisky = isRisky(to)
  const backToActive = to === "active" && isRisky(from)

  let lookup: AccountLookup | undefined
  let holdOutcome: HoldOutcome | undefined
  if (intoRisky || backToActive) {
    lookup = await findAccountByBridgeCustomerId(customerId)
    if (CASHOUT_HOLD_STATUSES.has(to)) {
      holdOutcome = await holdCashouts(lookup, customerId, from, to)
      if (holdOutcome === "placed") summary.holdsPlaced++
    }
    // Alert before recording, so a run that dies in between repeats the alert
    // (PagerDuty folds it into the same incident) rather than losing it.
    alertStatusChange({
      customerId,
      from,
      to,
      severity: intoRisky ? RISKY_STATUS_SEVERITY[to] : "info",
      lookup,
      holdOutcome,
    })
    summary.alerts++
  }

  logger.info(
    {
      customerId,
      from: from ?? "unseen",
      to,
      accountId: lookup?.kind === "found" ? lookup.account.id : stored?.accountId,
      alerted: intoRisky || backToActive,
      holdOutcome,
    },
    "Bridge customer status changed",
  )

  if (holdOutcome && !FINAL_HOLD_OUTCOMES.has(holdOutcome)) {
    // Leave the stored status as it was: the next run sees the same change
    // and retries the hold.
    summary.failures++
    return
  }

  const recorded = await recordCustomerStatusChange({
    customerId,
    from,
    to,
    accountId: lookup?.kind === "found" ? (lookup.account.id as string) : undefined,
  })
  if (recorded instanceof Error) {
    logger.error(
      { error: recorded, customerId, from, to },
      "Failed to store Bridge customer status; the change is seen again next run",
    )
    summary.failures++
    return
  }
  if (!recorded.applied) {
    logger.warn(
      { customerId, from, to },
      "Bridge customer status was recorded by another run first",
    )
  }
}

const seedBaseline = async (
  customers: { customerId: string; status: string }[],
  summary: CustomerStatusWatchSummary,
): Promise<CustomerStatusWatchSummary> => {
  const seeded = await seedCustomerStatuses(customers)
  if (seeded instanceof Error) {
    logger.error({ error: seeded }, "Failed to seed Bridge customer statuses")
    return { ...summary, pollFailed: true }
  }

  const riskyIds: Record<string, string[]> = {}
  for (const { customerId, status } of customers) {
    if (!isRisky(status)) continue
    ;(riskyIds[status] ??= []).push(customerId)
  }
  const baselineRisky = Object.fromEntries(
    Object.entries(riskyIds).map(([status, ids]) => [status, ids.length]),
  )
  const riskyTotal = Object.values(baselineRisky).reduce((a, b) => a + b, 0)

  logger.info(
    { customers: customers.length, baselineRisky, riskyCustomerIds: riskyIds },
    `Bridge customer status baseline recorded: ${customers.length} customers, ${riskyTotal} already paused, restricted, offboarded or rejected`,
  )
  notifyOpsEvent({
    flow: "customer",
    phase: "status-baseline",
    status: riskyTotal > 0 ? "pending" : "success",
    step: `${customers.length} customers, ${riskyTotal} in a risky status`,
    meta: Object.fromEntries(
      Object.entries(baselineRisky).map(([status, count]) => [status, String(count)]),
    ),
  })

  return { ...summary, seeded: true, baselineRisky }
}

export const watchBridgeCustomerStatuses =
  async (): Promise<CustomerStatusWatchSummary> => {
    const summary: CustomerStatusWatchSummary = {
      fetched: 0,
      seeded: false,
      baselineRisky: {},
      changes: 0,
      alerts: 0,
      holdsPlaced: 0,
      failures: 0,
      pollFailed: false,
    }

    const customers = await fetchAllCustomers()
    if (customers instanceof Error) {
      // Bridge outages (5xx, timeouts) already page from the client.
      logger.error({ error: customers }, "Bridge customer list poll failed")
      alertBridge({
        dedupKey: generateDedupKey.bridgeCustomerStatusPollFailed(),
        source: "bridge-customer-status",
        severity: "warning",
        title:
          "Bridge customer list poll failed: customer status changes are not being watched",
        detail: customers.message,
      })
      return { ...summary, pollFailed: true }
    }

    const current = customers
      .filter((customer) => customer?.id && customer.status)
      .map((customer) => ({ customerId: customer.id, status: customer.status as string }))
    summary.fetched = current.length

    const stored = await loadCustomerStatuses()
    if (stored instanceof Error) {
      logger.error({ error: stored }, "Failed to read stored Bridge customer statuses")
      return { ...summary, pollFailed: true }
    }

    if (!stored.baselineComplete) return seedBaseline(current, summary)

    for (const { customerId, status } of current) {
      const record = stored.statuses.get(customerId)
      if (record?.status === status) continue
      summary.changes++
      try {
        await handleChange(customerId, record, status, summary)
      } catch (error) {
        logger.error({ error, customerId }, "Bridge customer status handler threw")
        summary.failures++
      }
    }

    return summary
  }
