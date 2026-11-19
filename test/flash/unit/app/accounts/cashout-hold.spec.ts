// ENG-889: cash-out holds are placed by the Bridge customer status watch and
// released only by ops, with a record of who did it.

const mockPlace = jest.fn()
const mockRelease = jest.fn()
const mockNotifyOpsEvent = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    placeCashoutHold: (...args: unknown[]) => mockPlace(...args),
    releaseCashoutHold: (...args: unknown[]) => mockRelease(...args),
  }),
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: unknown[]) => mockNotifyOpsEvent(...args),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  placeCashoutHold,
  placeCashoutHoldByAdmin,
  releaseCashoutHold,
} from "@app/accounts/cashout-hold"
import { InvalidAccountIdError } from "@domain/accounts"
import { NoCashoutHoldToReleaseError } from "@domain/errors"
import { baseLogger } from "@services/logger"

const ACCOUNT_ID = "5f4c9a2b1e7d3f8a6b0c4d2e"
const previousHold = {
  reason: "Bridge customer cust_1 went from active to offboarded",
  source: "bridge-customer-status",
  setAt: new Date(),
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("placeCashoutHold", () => {
  it("stamps the hold with its time and no user for a system hold", async () => {
    mockPlace.mockResolvedValue({ placed: true, account: { id: ACCOUNT_ID } })

    await placeCashoutHold({
      accountId: ACCOUNT_ID as AccountId,
      reason: previousHold.reason,
      source: previousHold.source,
    })

    expect(mockPlace).toHaveBeenCalledWith(ACCOUNT_ID, {
      reason: previousHold.reason,
      source: previousHold.source,
      setAt: expect.any(Date),
    })
  })
})

describe("placeCashoutHoldByAdmin", () => {
  it("places an admin hold attributed to the caller, logs it and tells the ops feed", async () => {
    mockPlace.mockResolvedValue({ placed: true, account: { id: ACCOUNT_ID } })

    const result = await placeCashoutHoldByAdmin({
      id: ACCOUNT_ID,
      reason: "baseline: already offboarded",
      placedByUserId: "ops-user" as UserId,
    })

    expect(result).toEqual({ placed: true, account: { id: ACCOUNT_ID } })
    expect(mockPlace).toHaveBeenCalledWith(ACCOUNT_ID, {
      reason: "baseline: already offboarded",
      source: "admin",
      setAt: expect.any(Date),
      setByUserId: "ops-user",
    })
    expect(baseLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID, placedByUserId: "ops-user" }),
      "admin placed cash-out hold",
    )
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "cashout",
        phase: "hold-placed",
        accountId: ACCOUNT_ID,
        userId: "ops-user",
      }),
    )
  })

  it("keeps an existing hold and does not tell the ops feed", async () => {
    mockPlace.mockResolvedValue({
      placed: false,
      account: { id: ACCOUNT_ID, cashoutHold: previousHold },
    })

    const result = await placeCashoutHoldByAdmin({
      id: ACCOUNT_ID,
      reason: "review",
      placedByUserId: "ops-user" as UserId,
    })

    expect(result).toEqual({
      placed: false,
      account: { id: ACCOUNT_ID, cashoutHold: previousHold },
    })
    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
  })

  it("refuses a malformed account id without touching the store", async () => {
    const result = await placeCashoutHoldByAdmin({
      id: "not-an-id",
      reason: "review",
      placedByUserId: "ops-user" as UserId,
    })

    expect(result).toBeInstanceOf(InvalidAccountIdError)
    expect(mockPlace).not.toHaveBeenCalled()
  })
})

describe("releaseCashoutHold", () => {
  it("releases, logs who did it and tells the ops feed", async () => {
    mockRelease.mockResolvedValue({ account: { id: ACCOUNT_ID }, previousHold })

    const result = await releaseCashoutHold({
      id: ACCOUNT_ID,
      releasedByUserId: "ops-user" as UserId,
      comment: "reviewed",
    })

    expect(result).toEqual({ account: { id: ACCOUNT_ID }, previousHold })
    expect(mockRelease).toHaveBeenCalledWith(ACCOUNT_ID, {
      releasedByUserId: "ops-user",
      comment: "reviewed",
    })
    expect(baseLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID, releasedByUserId: "ops-user" }),
      "admin released cash-out hold",
    )
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "cashout",
        phase: "hold-released",
        accountId: ACCOUNT_ID,
        step: "held by bridge-customer-status",
      }),
    )
  })

  it("refuses a malformed account id without touching the store", async () => {
    const result = await releaseCashoutHold({
      id: "not-an-id",
      releasedByUserId: "ops-user" as UserId,
    })

    expect(result).toBeInstanceOf(InvalidAccountIdError)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it("passes a 'no hold' refusal through and logs it", async () => {
    mockRelease.mockResolvedValue(new NoCashoutHoldToReleaseError(ACCOUNT_ID))

    const result = await releaseCashoutHold({
      id: ACCOUNT_ID,
      releasedByUserId: "ops-user" as UserId,
    })

    expect(result).toBeInstanceOf(NoCashoutHoldToReleaseError)
    expect(baseLogger.warn).toHaveBeenCalled()
    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
  })
})
