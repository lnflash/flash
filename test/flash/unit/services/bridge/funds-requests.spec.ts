// ENG-889: Bridge funds requests (sender-bank recalls) are polled, alerted on
// once, noted on the deposit's ERPNext row, and lock the account when Bridge
// flags fraud.

const mockListFundsRequests = jest.fn()
const mockRecordSeen = jest.fn()
const mockUpdateProgress = jest.fn()
const mockRecordRecall = jest.fn()
const mockFindByBridgeCustomerId = jest.fn()
const mockUpdateAccountStatus = jest.fn()

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: {
    listFundsRequests: (...args: unknown[]) => mockListFundsRequests(...args),
  },
}))

jest.mock("@services/mongoose/bridge-funds-request", () => ({
  recordFundsRequestSeen: (...args: unknown[]) => mockRecordSeen(...args),
  updateFundsRequestProgress: (...args: unknown[]) => mockUpdateProgress(...args),
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  recordBridgeDepositRecall: (...args: unknown[]) => mockRecordRecall(...args),
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: () => ({
    findByBridgeCustomerId: (...args: unknown[]) => mockFindByBridgeCustomerId(...args),
  }),
}))

jest.mock("@app/accounts/update-account-status", () => ({
  updateAccountStatus: (...args: unknown[]) => mockUpdateAccountStatus(...args),
}))

jest.mock("@services/alerts", () => ({
  alertBridge: jest.fn(),
  generateDedupKey: jest.requireActual("@services/alerts/dedup-key").generateDedupKey,
}))

jest.mock("@services/logger", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { baseLogger: { ...logger, child: () => logger } }
})

import { AccountStatus } from "@domain/accounts"
import { CouldNotFindAccountError, UnknownRepositoryError } from "@domain/errors"
import { alertBridge } from "@services/alerts"
import {
  FUNDS_REQUEST_LOOKBACK_DAYS,
  fundsRequestLockComment,
  watchBridgeFundsRequests,
} from "@services/bridge/funds-requests"
import { BridgeApiError } from "@services/bridge/errors"

const NOW = new Date("2026-11-19T12:00:00.000Z")

// The module logger the watcher writes to (the mock's child()).
const mockLogger = jest.requireMock("@services/logger").baseLogger.child()

const fraudRequest = {
  id: "fr_fraud",
  deposit_id: "deposit_wire_5000",
  customer_id: "cust_wire",
  amount: "5000.0",
  currency: "usd",
  payment_rail: "wire",
  fraud: true,
  notice_date: "2026-11-18",
  imad: "20261113XXXX",
  created_at: "2026-11-18T10:00:00.000Z",
}

const nonFraudRequest = { ...fraudRequest, id: "fr_plain", fraud: false }

const activeAccount = { id: "acct_wire", status: AccountStatus.Active }

const newRecord = (fr: { id: string; fraud: boolean }) => ({
  inserted: true,
  record: { fundsRequestId: fr.id, fraud: fr.fraud },
})

const page = (data: unknown[]) => ({ count: data.length, data })

beforeEach(() => {
  jest.clearAllMocks()
  mockListFundsRequests.mockResolvedValue(page([]))
  mockUpdateProgress.mockResolvedValue(true)
  mockRecordRecall.mockResolvedValue("updated")
  mockFindByBridgeCustomerId.mockResolvedValue(activeAccount)
  mockUpdateAccountStatus.mockResolvedValue({ ...activeAccount, status: "locked" })
})

describe("watchBridgeFundsRequests: polling", () => {
  it("asks for the lookback window, 100 at a time", async () => {
    await watchBridgeFundsRequests({ now: NOW })

    const since = new Date(NOW.getTime() - FUNDS_REQUEST_LOOKBACK_DAYS * 86_400_000)
    expect(mockListFundsRequests).toHaveBeenCalledWith({
      limit: 100,
      startingAfter: undefined,
      noticeDateStartingOn: since.toISOString().slice(0, 10),
    })
  })

  it("follows the cursor while pages are full", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      ...nonFraudRequest,
      id: `fr_${i}`,
    }))
    mockListFundsRequests
      .mockResolvedValueOnce(page(full))
      .mockResolvedValueOnce(page([{ ...nonFraudRequest, id: "fr_last" }]))
    mockRecordSeen.mockResolvedValue({
      inserted: false,
      record: { alertedAt: new Date(), erpnextRecordedAt: new Date(), fraud: false },
    })

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(mockListFundsRequests).toHaveBeenCalledTimes(2)
    expect(mockListFundsRequests.mock.calls[1][0]).toEqual(
      expect.objectContaining({ startingAfter: "fr_99" }),
    )
    expect(summary.fetched).toBe(101)
  })

  it("alerts and does not throw when the Bridge API call fails", async () => {
    mockListFundsRequests.mockRejectedValue(
      new BridgeApiError("Bridge API error: 403 Forbidden", 403, {}),
    )

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(summary.pollFailed).toBe(true)
    expect(mockRecordSeen).not.toHaveBeenCalled()
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "bridge-funds-request:poll-failed",
        severity: "warning",
        detail: "Bridge API error: 403 Forbidden",
      }),
    )
  })
  it("skips the watch without failing or alerting when Bridge says the key is not allowed", async () => {
    // Production, 2026-11: the key gets 200 on /customers but this on
    // /funds_requests, and Bridge will not grant the permission.
    mockListFundsRequests.mockRejectedValue(
      new BridgeApiError("Bridge API error: 401 Unauthorized", 401, {
        code: "not_allowed",
        message: "Insufficient permissions for this endpoint",
      }),
    )

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(summary).toEqual(
      expect.objectContaining({ notPermitted: true, pollFailed: false, fetched: 0 }),
    )
    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockRecordSeen).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledTimes(1)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { status: 401, code: "not_allowed" },
      "Bridge funds requests not permitted for this API key; recall watch skipped",
    )
  })

  it("still fails the poll on a 401 with another code", async () => {
    mockListFundsRequests.mockRejectedValue(
      new BridgeApiError("Bridge API error: 401 Unauthorized", 401, {
        code: "invalid_api_key",
      }),
    )

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(summary).toEqual(
      expect.objectContaining({ pollFailed: true, notPermitted: false }),
    )
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: "bridge-funds-request:poll-failed" }),
    )
  })

  it("still fails the poll on a 5xx or a network error", async () => {
    mockListFundsRequests.mockRejectedValueOnce(
      new BridgeApiError("Bridge API error: 502 Bad Gateway", 502, null),
    )
    expect((await watchBridgeFundsRequests({ now: NOW })).pollFailed).toBe(true)

    mockListFundsRequests.mockRejectedValueOnce(new TypeError("fetch failed"))
    expect((await watchBridgeFundsRequests({ now: NOW })).pollFailed).toBe(true)
  })

  it("polls as normal once Bridge allows the endpoint", async () => {
    mockListFundsRequests.mockResolvedValue(page([]))

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(summary).toEqual(
      expect.objectContaining({ notPermitted: false, pollFailed: false }),
    )
  })
})

describe("watchBridgeFundsRequests: a new fraud recall", () => {
  beforeEach(() => {
    mockListFundsRequests.mockResolvedValue(page([fraudRequest]))
    mockRecordSeen.mockResolvedValue(newRecord(fraudRequest))
  })

  it("locks the account with the funds request named in the comment", async () => {
    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(mockFindByBridgeCustomerId).toHaveBeenCalledWith("cust_wire")
    expect(mockUpdateAccountStatus).toHaveBeenCalledWith({
      id: "acct_wire",
      status: AccountStatus.Locked,
      comment: "Bridge funds request fr_fraud: fraud recall of deposit deposit_wire_5000",
    })
    expect(summary).toEqual(
      expect.objectContaining({ newRequests: 1, locked: 1, failures: 0 }),
    )
    expect(mockUpdateProgress).toHaveBeenCalledWith(
      "fr_fraud",
      expect.objectContaining({
        accountId: "acct_wire",
        lockOutcome: "locked",
        lockDoneAt: expect.any(Date),
        erpnextOutcome: "updated",
        erpnextRecordedAt: expect.any(Date),
      }),
    )
  })

  it("notes the recall on the deposit's ERPNext row", async () => {
    await watchBridgeFundsRequests({ now: NOW })

    expect(mockRecordRecall).toHaveBeenCalledWith({
      depositId: "deposit_wire_5000",
      note: "Recalled by sender's bank: Bridge funds request fr_fraud, fraud, notice 2026-11-18",
    })
  })

  it("stamps alertedAt in the progress write that follows the page", async () => {
    await watchBridgeFundsRequests({ now: NOW })

    expect(mockUpdateProgress).toHaveBeenCalledWith(
      "fr_fraud",
      expect.objectContaining({ alertedAt: expect.any(Date) }),
    )
    const pagedAt = (alertBridge as jest.Mock).mock.invocationCallOrder[0]
    const storedAt = mockUpdateProgress.mock.invocationCallOrder[0]
    expect(pagedAt).toBeLessThan(storedAt)
  })

  it("pages ops once, critical, with the deposit, account and lock result", async () => {
    await watchBridgeFundsRequests({ now: NOW })

    expect(alertBridge).toHaveBeenCalledTimes(1)
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "bridge-funds-request:fr_fraud",
        source: "bridge-funds-request",
        severity: "critical",
        title: "Bridge deposit recalled by sender's bank (FRAUD): 5000.0 USD",
        detail: expect.stringContaining("the Flash account is now LOCKED"),
        context: expect.objectContaining({
          funds_request_id: "fr_fraud",
          deposit_id: "deposit_wire_5000",
          customer_id: "cust_wire",
          account_id: "acct_wire",
          fraud: true,
          lock: "locked",
          erpnext_row: "updated",
        }),
      }),
    )
  })

  it("does not lock twice when the account is already locked", async () => {
    mockFindByBridgeCustomerId.mockResolvedValue({
      ...activeAccount,
      status: AccountStatus.Locked,
    })

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
    expect(summary.locked).toBe(0)
    expect(mockUpdateProgress).toHaveBeenCalledWith(
      "fr_fraud",
      expect.objectContaining({
        lockOutcome: "already_locked",
        lockDoneAt: expect.any(Date),
      }),
    )
  })

  it("leaves a closed account closed", async () => {
    mockFindByBridgeCustomerId.mockResolvedValue({
      ...activeAccount,
      status: AccountStatus.Closed,
    })

    await watchBridgeFundsRequests({ now: NOW })

    expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
    expect(mockUpdateProgress).toHaveBeenCalledWith(
      "fr_fraud",
      expect.objectContaining({ lockOutcome: "account_closed" }),
    )
  })

  it("does not crash and says so when no account has the Bridge customer id", async () => {
    mockFindByBridgeCustomerId.mockResolvedValue(new CouldNotFindAccountError())

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
    expect(summary.failures).toBe(0)
    expect(mockUpdateProgress).toHaveBeenCalledWith(
      "fr_fraud",
      expect.objectContaining({
        lockOutcome: "account_not_found",
        lockDoneAt: expect.any(Date),
      }),
    )
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("no Flash account has this Bridge customer id"),
      }),
    )
  })

  it("leaves the lock pending for the next run when the account lookup faults", async () => {
    mockFindByBridgeCustomerId.mockResolvedValue(new UnknownRepositoryError("mongo down"))

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(summary.failures).toBe(1)
    const progress = mockUpdateProgress.mock.calls[0][1]
    expect(progress.lockOutcome).toBe("lookup_failed")
    expect(progress).not.toHaveProperty("lockDoneAt")
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("locking the Flash account FAILED"),
      }),
    )
  })

  it("leaves the lock pending when the status update fails", async () => {
    mockUpdateAccountStatus.mockResolvedValue(new UnknownRepositoryError("write failed"))

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(summary.failures).toBe(1)
    expect(mockUpdateProgress.mock.calls[0][1].lockOutcome).toBe("lock_failed")
  })
})

describe("watchBridgeFundsRequests: a new non-fraud recall", () => {
  beforeEach(() => {
    mockListFundsRequests.mockResolvedValue(page([nonFraudRequest]))
    mockRecordSeen.mockResolvedValue(newRecord(nonFraudRequest))
  })

  it("alerts and notes the row but never locks the account", async () => {
    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
    expect(mockRecordRecall).toHaveBeenCalledWith(
      expect.objectContaining({
        depositId: "deposit_wire_5000",
        note: expect.stringContaining("not fraud"),
      }),
    )
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        title: "Bridge deposit recalled by sender's bank: 5000.0 USD",
        detail: expect.stringContaining("Not flagged as fraud"),
        context: expect.objectContaining({ account_id: "acct_wire", fraud: false }),
      }),
    )
    expect(summary).toEqual(expect.objectContaining({ newRequests: 1, locked: 0 }))
  })

  it("retries the ERPNext note next run when the deposit row is not there yet", async () => {
    mockRecordRecall.mockResolvedValue("not_found")

    const summary = await watchBridgeFundsRequests({ now: NOW })

    const progress = mockUpdateProgress.mock.calls[0][1]
    expect(progress.erpnextOutcome).toBe("row_not_found")
    expect(progress).not.toHaveProperty("erpnextRecordedAt")
    expect(summary.failures).toBe(1)
  })

  it("records a recall with no deposit id without calling ERPNext", async () => {
    mockListFundsRequests.mockResolvedValue(
      page([{ ...nonFraudRequest, deposit_id: undefined }]),
    )

    await watchBridgeFundsRequests({ now: NOW })

    expect(mockRecordRecall).not.toHaveBeenCalled()
    expect(mockUpdateProgress.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        erpnextOutcome: "no_deposit_id",
        erpnextRecordedAt: expect.any(Date),
      }),
    )
  })
})

describe("watchBridgeFundsRequests: a request already seen", () => {
  it("does nothing when every step is done", async () => {
    mockListFundsRequests.mockResolvedValue(page([fraudRequest]))
    mockRecordSeen.mockResolvedValue({
      inserted: false,
      record: {
        fundsRequestId: "fr_fraud",
        fraud: true,
        alertedAt: new Date(),
        erpnextRecordedAt: new Date(),
        lockDoneAt: new Date(),
        lockOutcome: "locked",
      },
    })

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockRecordRecall).not.toHaveBeenCalled()
    expect(mockFindByBridgeCustomerId).not.toHaveBeenCalled()
    expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
    expect(mockUpdateProgress).not.toHaveBeenCalled()
    expect(summary.newRequests).toBe(0)
  })

  it("retries a failed lock without paging again, then tells ops it is done", async () => {
    mockListFundsRequests.mockResolvedValue(page([fraudRequest]))
    mockRecordSeen.mockResolvedValue({
      inserted: false,
      record: {
        fundsRequestId: "fr_fraud",
        fraud: true,
        accountId: "acct_wire",
        alertedAt: new Date(),
        erpnextRecordedAt: new Date(),
        erpnextOutcome: "updated",
        lockOutcome: "lookup_failed",
      },
    })

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(mockRecordRecall).not.toHaveBeenCalled()
    expect(mockUpdateAccountStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acct_wire",
        comment: fundsRequestLockComment(fraudRequest),
      }),
    )
    expect(summary.locked).toBe(1)
    expect(alertBridge).toHaveBeenCalledTimes(1)
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        dedupKey: "bridge-funds-request:fr_fraud:locked-on-retry",
      }),
    )
  })

  it("pages a request stored by a run that died before paging, and stamps alertedAt", async () => {
    // inserted is false (the record exists) but no page was ever recorded.
    mockListFundsRequests.mockResolvedValue(page([fraudRequest]))
    mockRecordSeen.mockResolvedValue({
      inserted: false,
      record: {
        fundsRequestId: "fr_fraud",
        fraud: true,
        accountId: "acct_wire",
        erpnextRecordedAt: new Date(),
        erpnextOutcome: "updated",
        lockDoneAt: new Date(),
        lockOutcome: "locked",
      },
    })

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(mockRecordRecall).not.toHaveBeenCalled()
    expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
    expect(alertBridge).toHaveBeenCalledTimes(1)
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "bridge-funds-request:fr_fraud",
        severity: "critical",
        context: expect.objectContaining({
          account_id: "acct_wire",
          erpnext_row: "updated",
          lock: "locked",
        }),
      }),
    )
    expect(mockUpdateProgress).toHaveBeenCalledWith(
      "fr_fraud",
      expect.objectContaining({ alertedAt: expect.any(Date) }),
    )
    expect(summary.newRequests).toBe(0)
  })

  it("does not repeat the locked-on-retry notice for a lock done on an earlier run", async () => {
    mockListFundsRequests.mockResolvedValue(page([fraudRequest]))
    mockRecordSeen.mockResolvedValue({
      inserted: false,
      record: {
        fundsRequestId: "fr_fraud",
        fraud: true,
        accountId: "acct_wire",
        alertedAt: new Date(),
        erpnextOutcome: "row_not_found",
        lockDoneAt: new Date(),
        lockOutcome: "locked",
      },
    })

    await watchBridgeFundsRequests({ now: NOW })

    expect(mockRecordRecall).toHaveBeenCalledTimes(1)
    expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
    expect(alertBridge).not.toHaveBeenCalled()
  })

  it("retries a missing ERPNext note without alerting or touching the account", async () => {
    mockListFundsRequests.mockResolvedValue(page([nonFraudRequest]))
    mockRecordSeen.mockResolvedValue({
      inserted: false,
      record: {
        fundsRequestId: "fr_plain",
        fraud: false,
        accountId: "acct_wire",
        alertedAt: new Date(),
        erpnextOutcome: "row_not_found",
      },
    })

    await watchBridgeFundsRequests({ now: NOW })

    expect(mockRecordRecall).toHaveBeenCalledTimes(1)
    expect(mockFindByBridgeCustomerId).not.toHaveBeenCalled()
    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockUpdateProgress).toHaveBeenCalledWith(
      "fr_plain",
      expect.objectContaining({
        accountId: "acct_wire",
        erpnextOutcome: "updated",
        erpnextRecordedAt: expect.any(Date),
      }),
    )
  })
})

describe("watchBridgeFundsRequests: persistence failures", () => {
  it("skips a request it cannot store, without alerting, and keeps going", async () => {
    mockListFundsRequests.mockResolvedValue(page([fraudRequest, nonFraudRequest]))
    mockRecordSeen
      .mockResolvedValueOnce(new Error("mongo down"))
      .mockResolvedValueOnce(newRecord(nonFraudRequest))

    const summary = await watchBridgeFundsRequests({ now: NOW })

    expect(mockUpdateAccountStatus).not.toHaveBeenCalled()
    expect(alertBridge).toHaveBeenCalledTimes(1)
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: "bridge-funds-request:fr_plain" }),
    )
    expect(summary).toEqual(expect.objectContaining({ failures: 1, newRequests: 1 }))
  })
})
