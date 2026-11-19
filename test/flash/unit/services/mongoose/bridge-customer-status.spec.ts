// ENG-889: the customer status store is what the hourly watch compares
// Bridge's statuses against; a change is recorded only against the status the
// run read.

const find = jest.fn()
const bulkWrite = jest.fn()
const updateOne = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  BridgeCustomerStatus: {
    find: (...args: unknown[]) => find(...args),
    bulkWrite: (...args: unknown[]) => bulkWrite(...args),
    updateOne: (...args: unknown[]) => updateOne(...args),
  },
}))

import {
  BASELINE_COMPLETE_MARKER_ID,
  loadCustomerStatuses,
  recordCustomerStatusChange,
  seedCustomerStatuses,
} from "@services/mongoose/bridge-customer-status"

beforeEach(() => {
  find.mockReset()
  bulkWrite.mockReset()
  updateOne.mockReset()
})

describe("loadCustomerStatuses", () => {
  it("returns the stored statuses keyed by customer id", async () => {
    find.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve([
            { customerId: "cust_1", status: "active" },
            { customerId: "cust_2", status: "paused" },
          ]),
      }),
    })

    const result = await loadCustomerStatuses()
    if (result instanceof Error) throw result

    expect(result.statuses).toBeInstanceOf(Map)
    expect(result.statuses.get("cust_2")?.status).toBe("paused")
    expect(result.baselineComplete).toBe(false)
  })

  it("reports the baseline marker and leaves it out of the statuses", async () => {
    find.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve([
            { customerId: "cust_1", status: "active" },
            { customerId: BASELINE_COMPLETE_MARKER_ID, status: "baseline" },
          ]),
      }),
    })

    const result = await loadCustomerStatuses()
    if (result instanceof Error) throw result

    expect(result.baselineComplete).toBe(true)
    expect(result.statuses.size).toBe(1)
    expect(result.statuses.has(BASELINE_COMPLETE_MARKER_ID)).toBe(false)
  })

  it("returns a Mongo fault as an error", async () => {
    find.mockImplementation(() => {
      throw new Error("mongo down")
    })

    expect(await loadCustomerStatuses()).toBeInstanceOf(Error)
  })
})

describe("seedCustomerStatuses", () => {
  it("inserts if absent, in batches of 500", async () => {
    bulkWrite.mockResolvedValue({})
    const customers = Array.from({ length: 501 }, (_, i) => ({
      customerId: `cust_${i}`,
      status: "active",
    }))

    expect(await seedCustomerStatuses(customers)).toBe(true)

    expect(bulkWrite).toHaveBeenCalledTimes(2)
    expect(bulkWrite.mock.calls[0][0]).toHaveLength(500)
    expect(bulkWrite.mock.calls[1][0]).toHaveLength(1)
    expect(bulkWrite.mock.calls[1][0][0]).toEqual({
      updateOne: {
        filter: { customerId: { $eq: "cust_500" } },
        update: {
          $setOnInsert: expect.objectContaining({
            customerId: "cust_500",
            status: "active",
          }),
        },
        upsert: true,
      },
    })
    // The marker is written once, after every batch.
    expect(updateOne).toHaveBeenCalledTimes(1)
    expect(updateOne.mock.calls[0][0]).toEqual({
      customerId: { $eq: BASELINE_COMPLETE_MARKER_ID },
    })
    expect(updateOne.mock.calls[0][2]).toEqual({ upsert: true })
    expect(bulkWrite.mock.invocationCallOrder[1]).toBeLessThan(
      updateOne.mock.invocationCallOrder[0],
    )
  })

  it("returns a Mongo fault as an error", async () => {
    bulkWrite.mockRejectedValue(new Error("mongo down"))

    expect(
      await seedCustomerStatuses([{ customerId: "c", status: "active" }]),
    ).toBeInstanceOf(Error)
  })

  it("writes no baseline marker when a later batch fails", async () => {
    bulkWrite.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("step down"))
    const customers = Array.from({ length: 501 }, (_, i) => ({
      customerId: `cust_${i}`,
      status: "active",
    }))

    expect(await seedCustomerStatuses(customers)).toBeInstanceOf(Error)
    expect(updateOne).not.toHaveBeenCalled()
  })
})

describe("recordCustomerStatusChange", () => {
  it("updates only if the store still holds the status the run read", async () => {
    updateOne.mockResolvedValue({ modifiedCount: 1 })

    const result = await recordCustomerStatusChange({
      customerId: "cust_1",
      from: "active",
      to: "paused",
      accountId: "acct_1",
    })

    expect(result).toEqual({ applied: true })
    expect(updateOne).toHaveBeenCalledWith(
      { customerId: { $eq: "cust_1" }, status: { $eq: "active" } },
      {
        $set: expect.objectContaining({
          status: "paused",
          previousStatus: "active",
          accountId: "acct_1",
        }),
      },
    )
  })

  it("reports not applied when another run changed it first", async () => {
    updateOne.mockResolvedValue({ modifiedCount: 0 })

    expect(
      await recordCustomerStatusChange({
        customerId: "cust_1",
        from: "active",
        to: "paused",
      }),
    ).toEqual({ applied: false })
  })

  it("inserts a customer seen for the first time without overwriting", async () => {
    updateOne.mockResolvedValue({ upsertedCount: 1 })

    const result = await recordCustomerStatusChange({
      customerId: "cust_new",
      to: "not_started",
    })

    expect(result).toEqual({ applied: true })
    expect(updateOne).toHaveBeenCalledWith(
      { customerId: { $eq: "cust_new" } },
      { $setOnInsert: expect.objectContaining({ status: "not_started" }) },
      { upsert: true },
    )
  })

  it("returns a Mongo fault as an error", async () => {
    updateOne.mockRejectedValue(new Error("mongo down"))

    expect(
      await recordCustomerStatusChange({ customerId: "c", from: "active", to: "paused" }),
    ).toBeInstanceOf(Error)
  })
})
