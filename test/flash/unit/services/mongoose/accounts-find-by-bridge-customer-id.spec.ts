// ENG-889: the recall watcher tells "no account has this Bridge customer"
// (final, nothing to lock) from a Mongo fault (retry next run) by the class of
// the error findByBridgeCustomerId returns.

import {
  CouldNotFindAccountError,
  CouldNotFindError,
  RepositoryError,
} from "@domain/errors"
import { AccountsRepository } from "@services/mongoose/accounts"

const findOne = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  Account: { findOne: (...args: unknown[]) => findOne(...args) },
}))

jest.mock("@services/mongoose/utils", () => ({
  toObjectId: jest.fn((id) => id),
  fromObjectId: jest.fn((id) => id),
  parseRepositoryError: jest.requireActual("@services/mongoose/utils")
    .parseRepositoryError,
}))

const CUSTOMER_ID = "cust_wire" as BridgeCustomerId

const accountRecord = {
  _id: "account-id",
  id: "5a9f6f45-0a3a-4b0a-9f3e-1e0f9b1b1b1b",
  created_at: new Date(),
  bridgeCustomerId: CUSTOMER_ID,
  level: 1,
  statusHistory: [{ status: "active" }],
  contacts: [],
  earn: [],
}

describe("AccountsRepository.findByBridgeCustomerId", () => {
  beforeEach(() => {
    findOne.mockReset()
  })

  it("looks the account up by Bridge customer id with $eq", async () => {
    findOne.mockResolvedValue(accountRecord)

    const result = await AccountsRepository().findByBridgeCustomerId(CUSTOMER_ID)

    expect(findOne).toHaveBeenCalledWith({ bridgeCustomerId: { $eq: CUSTOMER_ID } })
    expect(result).not.toBeInstanceOf(Error)
  })

  it("reports a miss as CouldNotFindAccountError", async () => {
    findOne.mockResolvedValue(null)

    const result = await AccountsRepository().findByBridgeCustomerId(CUSTOMER_ID)

    expect(result).toBeInstanceOf(CouldNotFindAccountError)
    expect(result).toBeInstanceOf(RepositoryError)
  })

  it("does not report a Mongo fault as a miss", async () => {
    findOne.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:27017"))

    const result = await AccountsRepository().findByBridgeCustomerId(CUSTOMER_ID)

    expect(result).toBeInstanceOf(RepositoryError)
    expect(result).not.toBeInstanceOf(CouldNotFindError)
  })
})
