// ENG-889: the funds-request store decides whether a recall is new, and the
// watcher's "retry steps without re-paging" rests on what it returns.

const updateOne = jest.fn()
const findOne = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  BridgeFundsRequest: {
    updateOne: (...args: unknown[]) => updateOne(...args),
    findOne: (...args: unknown[]) => findOne(...args),
  },
}))

import {
  recordFundsRequestSeen,
  updateFundsRequestProgress,
} from "@services/mongoose/bridge-funds-request"

const seen = {
  fundsRequestId: "fr_1",
  depositId: "deposit_1",
  customerId: "cust_1",
  amount: "5000.0",
  currency: "usd",
  paymentRail: "wire",
  fraud: true,
  noticeDate: "2026-11-18",
  raw: { id: "fr_1" },
}

const stored = { fundsRequestId: "fr_1", fraud: true, alertedAt: new Date() }

const findOneResolving = (value: unknown) =>
  findOne.mockReturnValue({
    lean: () => ({ exec: () => Promise.resolve(value) }),
  })

beforeEach(() => {
  updateOne.mockReset()
  findOne.mockReset()
})

describe("recordFundsRequestSeen", () => {
  it("inserts only if absent, keyed on the funds request id with $eq", async () => {
    updateOne.mockResolvedValue({ upsertedCount: 1 })
    findOneResolving(stored)

    await recordFundsRequestSeen(seen)

    expect(updateOne).toHaveBeenCalledWith(
      { fundsRequestId: { $eq: "fr_1" } },
      {
        $setOnInsert: expect.objectContaining({
          ...seen,
          firstSeenAt: expect.any(Date),
          updatedAt: expect.any(Date),
        }),
      },
      { upsert: true },
    )
    const update = updateOne.mock.calls[0][1]
    expect(Object.keys(update)).toEqual(["$setOnInsert"])
    expect(findOne).toHaveBeenCalledWith({ fundsRequestId: { $eq: "fr_1" } })
  })

  it("reports inserted when the upsert created the record", async () => {
    updateOne.mockResolvedValue({ upsertedCount: 1, matchedCount: 0 })
    findOneResolving(stored)

    const result = await recordFundsRequestSeen(seen)

    expect(result).toEqual({ inserted: true, record: stored })
  })

  it("reports not inserted, with the stored record, when it already existed", async () => {
    updateOne.mockResolvedValue({ upsertedCount: 0, matchedCount: 1 })
    findOneResolving(stored)

    const result = await recordFundsRequestSeen(seen)

    expect(result).toEqual({ inserted: false, record: stored })
  })

  it("does not count a result without upsertedCount as an insert", async () => {
    updateOne.mockResolvedValue({ acknowledged: true })
    findOneResolving(stored)

    const result = await recordFundsRequestSeen(seen)

    expect(result).toEqual({ inserted: false, record: stored })
  })

  it("returns an error when the record cannot be read back", async () => {
    updateOne.mockResolvedValue({ upsertedCount: 1 })
    findOneResolving(null)

    const result = await recordFundsRequestSeen(seen)

    expect(result).toBeInstanceOf(Error)
  })

  it("returns, not throws, a Mongo fault", async () => {
    updateOne.mockRejectedValue(new Error("mongo down"))

    const result = await recordFundsRequestSeen(seen)

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe("mongo down")
    expect(findOne).not.toHaveBeenCalled()
  })
})

describe("updateFundsRequestProgress", () => {
  it("sets only the given fields, plus updatedAt", async () => {
    updateOne.mockResolvedValue({ matchedCount: 1 })
    const alertedAt = new Date()

    const result = await updateFundsRequestProgress("fr_1", {
      erpnextOutcome: "updated",
      alertedAt,
    })

    expect(result).toBe(true)
    expect(updateOne).toHaveBeenCalledWith(
      { fundsRequestId: { $eq: "fr_1" } },
      { $set: { erpnextOutcome: "updated", alertedAt, updatedAt: expect.any(Date) } },
    )
  })

  it("returns, not throws, a Mongo fault", async () => {
    updateOne.mockRejectedValue(new Error("mongo down"))

    const result = await updateFundsRequestProgress("fr_1", { lockOutcome: "locked" })

    expect(result).toBeInstanceOf(Error)
  })
})
