jest.mock("@config", () => ({ OnboardingEarn: {} }))

import { RepositoryError } from "@domain/errors"
import { AccountsRepository } from "@services/mongoose/accounts"
import { toBridgeCustomerId } from "@domain/primitives/bridge"

const findOneAndUpdate = jest.fn()
const find = jest.fn(),
  limit = jest.fn(),
  lean = jest.fn()
jest.mock("@services/mongoose/schema", () => ({
  Account: {
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
    find: (...args: unknown[]) => find(...args),
  },
}))
jest.mock("@services/mongoose/utils", () => ({
  toObjectId: jest.fn((id) => id),
  fromObjectId: jest.fn((id) => id),
  parseRepositoryError: jest.fn((error) => error),
}))

beforeEach(() => {
  findOneAndUpdate.mockReset()
  find.mockReset()
  limit.mockReset()
  lean.mockReset()
  find.mockReturnValue({ limit })
  limit.mockReturnValue({ lean })
})

it("atomically binds only an unbound account without overwriting an existing association", async () => {
  findOneAndUpdate.mockResolvedValue({
    _id: "account",
    id: "uuid",
    created_at: new Date(),
    username: "owner",
    level: 1,
    statusHistory: [{ status: "active" }],
    contacts: [],
    earn: [],
    bridgeCustomerId: "owned-new",
    bridgeKycStatus: "open",
  })
  const result = await AccountsRepository().bindBridgeCustomerIfUnbound(
    "account" as AccountId,
    toBridgeCustomerId("owned-new"),
  )
  expect(result).not.toBeInstanceOf(Error)
  expect((result as Account).bridgeCustomerId).toBe("owned-new")
  expect(findOneAndUpdate).toHaveBeenCalledWith(
    { _id: "account", bridgeCustomerId: null },
    { $set: { bridgeCustomerId: "owned-new", bridgeKycStatus: "open" } },
    { new: true },
  )
})

it("reports a lost association race without falling back to an unconditional update", async () => {
  findOneAndUpdate.mockResolvedValue(null)
  const result = await AccountsRepository().bindBridgeCustomerIfUnbound(
    "account" as AccountId,
    toBridgeCustomerId("must-not-replace"),
  )
  expect(result).toBeInstanceOf(RepositoryError)
  expect(findOneAndUpdate).toHaveBeenCalledTimes(1)
})

it("reads at most two owner IDs with an exact-customer filter and no PII fields", async () => {
  lean.mockResolvedValue([{ _id: "owner-one" }, { _id: "owner-two" }])
  const result = await AccountsRepository().findBridgeCustomerOwners(
    toBridgeCustomerId("cust_shared"),
  )
  expect(result).toEqual(["owner-one", "owner-two"])
  expect(find).toHaveBeenCalledWith(
    { bridgeCustomerId: { $eq: "cust_shared" } },
    { _id: 1 },
  )
  expect(limit).toHaveBeenCalledWith(2)
  expect(lean).toHaveBeenCalledTimes(1)
})
it("distinguishes no owners from a failed ownership query", async () => {
  lean
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new RepositoryError("Database unavailable"))
  expect(
    await AccountsRepository().findBridgeCustomerOwners(
      toBridgeCustomerId("cust_unbound"),
    ),
  ).toEqual([])
  expect(
    await AccountsRepository().findBridgeCustomerOwners(
      toBridgeCustomerId("cust_unbound"),
    ),
  ).toBeInstanceOf(RepositoryError)
})
