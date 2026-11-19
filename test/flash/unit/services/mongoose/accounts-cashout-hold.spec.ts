// ENG-889: a cash-out hold is placed only where none exists (so a retried run
// or an ops-placed hold is never overwritten) and released with a record of
// who released it.

import {
  CouldNotFindAccountFromIdError,
  NoCashoutHoldToReleaseError,
} from "@domain/errors"
import { AccountsRepository } from "@services/mongoose/accounts"

const findOneAndUpdate = jest.fn()
const findOne = jest.fn()
const exists = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  Account: {
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
    findOne: (...args: unknown[]) => findOne(...args),
    exists: (...args: unknown[]) => exists(...args),
  },
}))

jest.mock("@services/mongoose/utils", () => ({
  toObjectId: jest.fn((id) => id),
  fromObjectId: jest.fn((id) => id),
  parseRepositoryError: jest.requireActual("@services/mongoose/utils")
    .parseRepositoryError,
}))

const ACCOUNT_ID = "acct_1" as AccountId

const hold = {
  reason: "Bridge customer cust_1 went from active to offboarded",
  source: "bridge-customer-status",
  setAt: new Date("2026-11-19T12:00:00.000Z"),
}

const record = (extra: Record<string, unknown> = {}) => ({
  _id: ACCOUNT_ID,
  id: "5a9f6f45-0a3a-4b0a-9f3e-1e0f9b1b1b1b",
  created_at: new Date(),
  level: 1,
  statusHistory: [{ status: "active" }],
  contacts: [],
  earn: [],
  ...extra,
})

beforeEach(() => {
  findOneAndUpdate.mockReset()
  findOne.mockReset()
  exists.mockReset()
})

describe("AccountsRepository.placeCashoutHold", () => {
  it("sets the hold only where none is set, and logs it in the history", async () => {
    findOneAndUpdate.mockResolvedValue(record({ cashoutHold: hold }))

    const result = await AccountsRepository().placeCashoutHold(ACCOUNT_ID, hold)

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ACCOUNT_ID, cashoutHold: { $eq: null } },
      {
        $set: { cashoutHold: hold },
        $push: {
          cashoutHoldHistory: expect.objectContaining({
            action: "placed",
            reason: hold.reason,
            source: hold.source,
          }),
        },
      },
      { new: true },
    )
    expect(result).toEqual({
      placed: true,
      account: expect.objectContaining({ cashoutHold: expect.objectContaining(hold) }),
    })
  })

  it("keeps an existing hold and says so", async () => {
    findOneAndUpdate.mockResolvedValue(null)
    findOne.mockResolvedValue(record({ cashoutHold: { ...hold, source: "ops" } }))

    const result = await AccountsRepository().placeCashoutHold(ACCOUNT_ID, hold)

    expect(result).toEqual({
      placed: false,
      account: expect.objectContaining({
        cashoutHold: expect.objectContaining({ source: "ops" }),
      }),
    })
  })

  it("reports a missing account", async () => {
    findOneAndUpdate.mockResolvedValue(null)
    findOne.mockResolvedValue(null)

    expect(await AccountsRepository().placeCashoutHold(ACCOUNT_ID, hold)).toBeInstanceOf(
      CouldNotFindAccountFromIdError,
    )
  })
})

describe("AccountsRepository.releaseCashoutHold", () => {
  it("unsets the hold, records who released it, and returns the old hold", async () => {
    findOneAndUpdate.mockResolvedValue(record({ cashoutHold: hold }))

    const result = await AccountsRepository().releaseCashoutHold(ACCOUNT_ID, {
      releasedByUserId: "ops-user" as UserId,
      comment: "reviewed",
    })

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ACCOUNT_ID, cashoutHold: { $ne: null } },
      {
        $unset: { cashoutHold: "" },
        $push: {
          cashoutHoldHistory: expect.objectContaining({
            action: "released",
            byUserId: "ops-user",
            comment: "reviewed",
          }),
        },
      },
      { new: false },
    )
    expect(result).toEqual({
      account: expect.objectContaining({ id: ACCOUNT_ID, cashoutHold: undefined }),
      previousHold: expect.objectContaining(hold),
    })
  })

  it("tells 'no hold' from 'no account'", async () => {
    findOneAndUpdate.mockResolvedValue(null)

    exists.mockResolvedValue({ _id: ACCOUNT_ID })
    expect(
      await AccountsRepository().releaseCashoutHold(ACCOUNT_ID, {
        releasedByUserId: "ops-user" as UserId,
      }),
    ).toBeInstanceOf(NoCashoutHoldToReleaseError)

    exists.mockResolvedValue(null)
    expect(
      await AccountsRepository().releaseCashoutHold(ACCOUNT_ID, {
        releasedByUserId: "ops-user" as UserId,
      }),
    ).toBeInstanceOf(CouldNotFindAccountFromIdError)
  })
})
