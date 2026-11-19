// ENG-889: the hourly Bridge Job watches every Bridge customer's status,
// alerts ops when Bridge pauses, restricts, offboards or rejects one, and holds
// cash-outs for a restricted or offboarded one.

const mockListCustomers = jest.fn()
const mockLoadStatuses = jest.fn()
const mockSeedStatuses = jest.fn()
const mockRecordChange = jest.fn()
const mockFindByBridgeCustomerId = jest.fn()
const mockPlaceCashoutHold = jest.fn()

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: {
    listCustomers: (...args: unknown[]) => mockListCustomers(...args),
  },
}))

jest.mock("@services/mongoose/bridge-customer-status", () => ({
  loadCustomerStatuses: (...args: unknown[]) => mockLoadStatuses(...args),
  seedCustomerStatuses: (...args: unknown[]) => mockSeedStatuses(...args),
  recordCustomerStatusChange: (...args: unknown[]) => mockRecordChange(...args),
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: () => ({
    findByBridgeCustomerId: (...args: unknown[]) => mockFindByBridgeCustomerId(...args),
  }),
}))

jest.mock("@app/accounts/cashout-hold", () => ({
  placeCashoutHold: (...args: unknown[]) => mockPlaceCashoutHold(...args),
}))

jest.mock("@services/alerts", () => ({
  alertBridge: jest.fn(),
  generateDedupKey: jest.requireActual("@services/alerts/dedup-key").generateDedupKey,
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
}))

jest.mock("@services/logger", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { baseLogger: { ...logger, child: () => logger } }
})

import {
  CouldNotFindAccountError,
  CouldNotFindAccountFromIdError,
  UnknownRepositoryError,
} from "@domain/errors"
import { alertBridge } from "@services/alerts"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import {
  CASHOUT_HOLD_SOURCE,
  watchBridgeCustomerStatuses,
} from "@services/bridge/customer-status-watch"
import { BridgeApiError } from "@services/bridge/errors"

const mockLogger = jest.requireMock("@services/logger").baseLogger.child()

const customer = (id: string, status: string) => ({
  id,
  type: "individual",
  status,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-19T00:00:00.000Z",
})

const page = (data: unknown[]) => ({ count: data.length, data })

const stored = (entries: [string, string][], baselineComplete = true) => ({
  statuses: new Map(
    entries.map(([customerId, status]) => [customerId, { customerId, status }]),
  ),
  baselineComplete,
})

const account = {
  id: "acct_1",
  username: "ziontill",
  cashoutHold: undefined as AccountCashoutHold | undefined,
}

const alertCalls = () => (alertBridge as jest.Mock).mock.calls.map((c) => c[0])

beforeEach(() => {
  jest.clearAllMocks()
  mockListCustomers.mockResolvedValue(page([]))
  mockLoadStatuses.mockResolvedValue(stored([["cust_other", "active"]]))
  mockSeedStatuses.mockResolvedValue(true)
  mockRecordChange.mockResolvedValue({ applied: true })
  mockFindByBridgeCustomerId.mockResolvedValue({ ...account })
  mockPlaceCashoutHold.mockResolvedValue({ placed: true, account })
})

describe("watchBridgeCustomerStatuses: polling", () => {
  it("lists customers 100 at a time and follows the cursor while pages are full", async () => {
    const full = Array.from({ length: 100 }, (_, i) => customer(`cust_${i}`, "active"))
    mockListCustomers
      .mockResolvedValueOnce(page(full))
      .mockResolvedValueOnce(page([customer("cust_last", "active")]))

    const summary = await watchBridgeCustomerStatuses()

    expect(mockListCustomers).toHaveBeenCalledTimes(2)
    expect(mockListCustomers.mock.calls[0][0]).toEqual({
      limit: 100,
      startingAfter: undefined,
    })
    expect(mockListCustomers.mock.calls[1][0]).toEqual({
      limit: 100,
      startingAfter: "cust_99",
    })
    expect(summary.fetched).toBe(101)
  })

  it("alerts and fails the step when Bridge cannot be read", async () => {
    mockListCustomers.mockRejectedValue(
      new BridgeApiError("Bridge API error: 403 Forbidden", 403, {}),
    )

    const summary = await watchBridgeCustomerStatuses()

    expect(summary.pollFailed).toBe(true)
    expect(mockLoadStatuses).not.toHaveBeenCalled()
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "bridge-customer-status:poll-failed",
        severity: "warning",
      }),
    )
  })

  it("fails the step when the stored statuses cannot be read", async () => {
    mockListCustomers.mockResolvedValue(page([customer("cust_1", "paused")]))
    mockLoadStatuses.mockResolvedValue(new Error("mongo down"))

    const summary = await watchBridgeCustomerStatuses()

    expect(summary.pollFailed).toBe(true)
    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockRecordChange).not.toHaveBeenCalled()
  })
})

describe("watchBridgeCustomerStatuses: first run", () => {
  beforeEach(() => {
    mockLoadStatuses.mockResolvedValue(stored([], false))
    mockListCustomers.mockResolvedValue(
      page([
        customer("cust_a", "active"),
        customer("cust_b", "paused"),
        customer("cust_c", "deposits_restricted"),
        customer("cust_d", "offboarded"),
        customer("cust_e", "offboarded"),
        customer("cust_f", "under_review"),
      ]),
    )
  })

  it("seeds every status without alerting or holding", async () => {
    const summary = await watchBridgeCustomerStatuses()

    expect(mockSeedStatuses).toHaveBeenCalledWith([
      { customerId: "cust_a", status: "active" },
      { customerId: "cust_b", status: "paused" },
      { customerId: "cust_c", status: "deposits_restricted" },
      { customerId: "cust_d", status: "offboarded" },
      { customerId: "cust_e", status: "offboarded" },
      { customerId: "cust_f", status: "under_review" },
    ])
    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockPlaceCashoutHold).not.toHaveBeenCalled()
    expect(mockRecordChange).not.toHaveBeenCalled()
    expect(summary).toEqual(
      expect.objectContaining({
        seeded: true,
        baselineRisky: { paused: 1, deposits_restricted: 1, offboarded: 2 },
        alerts: 0,
      }),
    )
  })

  it("reports the baseline in one info line and one ops-feed message", async () => {
    await watchBridgeCustomerStatuses()

    const baselineLines = mockLogger.info.mock.calls.filter((call: unknown[]) =>
      String(call[1]).startsWith("Bridge customer status baseline recorded"),
    )
    expect(baselineLines).toHaveLength(1)
    expect(baselineLines[0][1]).toBe(
      "Bridge customer status baseline recorded: 6 customers, 4 already paused, restricted, offboarded or rejected",
    )
    expect(baselineLines[0][0]).toEqual(
      expect.objectContaining({
        riskyCustomerIds: {
          paused: ["cust_b"],
          deposits_restricted: ["cust_c"],
          offboarded: ["cust_d", "cust_e"],
        },
      }),
    )
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "customer",
        phase: "status-baseline",
        status: "pending",
        meta: { paused: "1", deposits_restricted: "1", offboarded: "2" },
      }),
    )
  })

  it("fails the step when the seed cannot be written", async () => {
    mockSeedStatuses.mockResolvedValue(new Error("mongo down"))

    const summary = await watchBridgeCustomerStatuses()

    expect(summary.pollFailed).toBe(true)
    expect(notifyOpsEvent).not.toHaveBeenCalled()
  })

  // A seed whose second batch failed leaves part of the store written and no
  // baseline marker. The next run must finish the seed, not read every customer
  // the seed missed as a change from "unseen".
  it("finishes a seed that failed part way without alerting or holding", async () => {
    mockSeedStatuses.mockResolvedValueOnce(new Error("primary stepped down"))
    const first = await watchBridgeCustomerStatuses()
    expect(first.pollFailed).toBe(true)

    // Batch 1 landed: cust_a and cust_b are stored, the rest are not.
    mockLoadStatuses.mockResolvedValue(
      stored(
        [
          ["cust_a", "active"],
          ["cust_b", "paused"],
        ],
        false,
      ),
    )
    const second = await watchBridgeCustomerStatuses()

    expect(mockSeedStatuses).toHaveBeenCalledTimes(2)
    expect(mockSeedStatuses.mock.calls[1][0]).toHaveLength(6)
    expect(second).toEqual(
      expect.objectContaining({ seeded: true, pollFailed: false, changes: 0, alerts: 0 }),
    )
    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockPlaceCashoutHold).not.toHaveBeenCalled()
    expect(mockRecordChange).not.toHaveBeenCalled()
  })

  it("compares against the store once the baseline marker is written", async () => {
    mockLoadStatuses.mockResolvedValue(stored([["cust_a", "active"]], true))

    const summary = await watchBridgeCustomerStatuses()

    expect(mockSeedStatuses).not.toHaveBeenCalled()
    expect(summary.seeded).toBe(false)
  })
})

describe("watchBridgeCustomerStatuses: transitions", () => {
  const runWith = async (from: string | undefined, to: string) => {
    mockLoadStatuses.mockResolvedValue(
      stored([["cust_other", "active"], ...(from ? [["cust_1", from]] : [])] as [
        string,
        string,
      ][]),
    )
    mockListCustomers.mockResolvedValue(
      page([customer("cust_other", "active"), customer("cust_1", to)]),
    )
    return watchBridgeCustomerStatuses()
  }

  it.each([
    ["deposits_restricted", "critical"],
    ["offboarded", "critical"],
    ["paused", "warning"],
    ["rejected", "warning"],
  ])("alerts on a change into %s at %s", async (to, severity) => {
    const summary = await runWith("active", to)

    expect(alertCalls()).toEqual([
      expect.objectContaining({
        dedupKey: `bridge-customer-status:cust_1:${to}`,
        source: "bridge-customer-status",
        severity,
        context: expect.objectContaining({
          customer_id: "cust_1",
          old_status: "active",
          new_status: to,
          account_id: "acct_1",
          username: "ziontill",
        }),
      }),
    ])
    expect(alertCalls()[0].title).toContain("ziontill (cust_1)")
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ flow: "customer", accountId: "acct_1" }),
    )
    expect(mockRecordChange).toHaveBeenCalledWith({
      customerId: "cust_1",
      from: "active",
      to,
      accountId: "acct_1",
    })
    expect(summary).toEqual(
      expect.objectContaining({ changes: 1, alerts: 1, failures: 0 }),
    )
  })

  it.each(["deposits_restricted", "offboarded"])(
    "holds cash-outs on the mapped account on a change into %s",
    async (to) => {
      const summary = await runWith("active", to)

      expect(mockPlaceCashoutHold).toHaveBeenCalledWith({
        accountId: "acct_1",
        reason: `Bridge customer cust_1 went from active to ${to}`,
        source: CASHOUT_HOLD_SOURCE,
      })
      expect(alertCalls()[0].detail).toContain("Cash-outs are now HELD")
      expect(alertCalls()[0].context.cashout_hold).toBe("placed")
      expect(summary.holdsPlaced).toBe(1)
    },
  )

  it.each(["paused", "rejected"])(
    "does not hold cash-outs on a change into %s",
    async (to) => {
      await runWith("active", to)

      expect(mockPlaceCashoutHold).not.toHaveBeenCalled()
    },
  )

  it("leaves an existing hold alone and still records the change", async () => {
    mockPlaceCashoutHold.mockResolvedValue({ placed: false, account })

    const summary = await runWith("paused", "offboarded")

    expect(alertCalls()[0].context.cashout_hold).toBe("already_held")
    expect(alertCalls()[0].detail).toContain("already had a cash-out hold")
    expect(summary.holdsPlaced).toBe(0)
    expect(summary.failures).toBe(0)
    expect(mockRecordChange).toHaveBeenCalledTimes(1)
  })

  it("alerts without a hold when no Flash account has the Bridge customer", async () => {
    mockFindByBridgeCustomerId.mockResolvedValue(
      new CouldNotFindAccountError("Account not found for Bridge customer ID"),
    )

    const summary = await runWith("active", "deposits_restricted")

    expect(mockPlaceCashoutHold).not.toHaveBeenCalled()
    expect(alertCalls()[0]).toEqual(
      expect.objectContaining({
        severity: "critical",
        title: "Bridge customer deposits restricted: cust_1",
        context: expect.objectContaining({
          account_id: undefined,
          account_lookup: "not_found",
          cashout_hold: "account_not_found",
        }),
      }),
    )
    expect(mockRecordChange).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cust_1", accountId: undefined }),
    )
    expect(summary.failures).toBe(0)
  })

  it("treats an account that vanished before the hold as not found", async () => {
    mockPlaceCashoutHold.mockResolvedValue(new CouldNotFindAccountFromIdError("acct_1"))

    const summary = await runWith("active", "offboarded")

    expect(alertCalls()[0].context.cashout_hold).toBe("account_not_found")
    expect(summary.failures).toBe(0)
    expect(mockRecordChange).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["the account lookup fails", "lookup_failed"],
    ["the hold write fails", "hold_failed"],
  ])(
    "does not record the change when %s, so the next run retries",
    async (_, outcome) => {
      if (outcome === "lookup_failed") {
        mockFindByBridgeCustomerId.mockResolvedValue(new UnknownRepositoryError("down"))
      } else {
        mockPlaceCashoutHold.mockResolvedValue(new UnknownRepositoryError("down"))
      }

      const summary = await runWith("active", "deposits_restricted")

      expect(alertCalls()[0].context.cashout_hold).toBe(outcome)
      expect(alertCalls()[0].detail).toContain("FAILED")
      expect(mockRecordChange).not.toHaveBeenCalled()
      expect(summary.failures).toBe(1)
    },
  )

  it("alerts at info on a change back to active and does not release the hold", async () => {
    mockFindByBridgeCustomerId.mockResolvedValue({
      ...account,
      cashoutHold: {
        reason: "Bridge customer cust_1 went from active to deposits_restricted",
        source: CASHOUT_HOLD_SOURCE,
        setAt: new Date(),
      },
    })

    await runWith("deposits_restricted", "active")

    expect(alertCalls()).toEqual([
      expect.objectContaining({
        dedupKey: "bridge-customer-status:cust_1:active",
        severity: "info",
        context: expect.objectContaining({ old_status: "deposits_restricted" }),
      }),
    ])
    expect(alertCalls()[0].detail).toContain(
      "cash-out hold is still on the Flash account",
    )
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", phase: "active" }),
    )
    expect(mockPlaceCashoutHold).not.toHaveBeenCalled()
    expect(mockRecordChange).toHaveBeenCalledWith(
      expect.objectContaining({ from: "deposits_restricted", to: "active" }),
    )
  })

  it("records a change between ordinary statuses without alerting", async () => {
    const summary = await runWith("under_review", "active")

    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockFindByBridgeCustomerId).not.toHaveBeenCalled()
    expect(mockRecordChange).toHaveBeenCalledWith({
      customerId: "cust_1",
      from: "under_review",
      to: "active",
      accountId: undefined,
    })
    expect(summary).toEqual(expect.objectContaining({ changes: 1, alerts: 0 }))
  })

  it("does nothing for a customer whose status is unchanged", async () => {
    const summary = await runWith("paused", "paused")

    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockRecordChange).not.toHaveBeenCalled()
    expect(summary.changes).toBe(0)
  })

  it("records a new customer silently", async () => {
    await runWith(undefined, "not_started")

    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockRecordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cust_1",
        from: undefined,
        to: "not_started",
      }),
    )
  })

  it("alerts and holds for a new customer that is already restricted", async () => {
    await runWith(undefined, "deposits_restricted")

    expect(alertCalls()[0]).toEqual(
      expect.objectContaining({
        severity: "critical",
        context: expect.objectContaining({ old_status: "unseen" }),
      }),
    )
    expect(mockPlaceCashoutHold).toHaveBeenCalledTimes(1)
  })

  it("counts a failed store write as a failure, after alerting", async () => {
    mockRecordChange.mockResolvedValue(new Error("mongo down"))

    const summary = await runWith("active", "paused")

    expect(alertBridge).toHaveBeenCalledTimes(1)
    expect(summary.failures).toBe(1)
  })

  it("keeps going after one customer's handler throws", async () => {
    mockLoadStatuses.mockResolvedValue(
      stored([
        ["cust_1", "active"],
        ["cust_2", "active"],
      ]),
    )
    mockListCustomers.mockResolvedValue(
      page([customer("cust_1", "paused"), customer("cust_2", "paused")]),
    )
    mockRecordChange.mockRejectedValueOnce(new Error("boom"))

    const summary = await watchBridgeCustomerStatuses()

    expect(alertBridge).toHaveBeenCalledTimes(2)
    expect(mockRecordChange).toHaveBeenCalledTimes(2)
    expect(mockRecordChange.mock.calls[1][0]).toEqual(
      expect.objectContaining({ customerId: "cust_2" }),
    )
    expect(summary.failures).toBe(1)
    expect(summary.changes).toBe(2)
  })
})
