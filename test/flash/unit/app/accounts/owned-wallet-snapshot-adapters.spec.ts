const mockAccount = jest.fn(),
  mockWallets = jest.fn()
jest.mock("@services/mongoose/schema", () => ({
  Account: { findOne: (...args: unknown[]) => mockAccount(...args) },
  Wallet: { find: (...args: unknown[]) => mockWallets(...args) },
}))
jest.mock("@services/mongoose/utils", () => ({
  toObjectId: (id: string) => id,
  fromObjectId: (id: string) => id,
}))

import { ownedWalletSnapshotDependencies } from "@app/accounts/owned-wallet-snapshot-adapters"

const INTERNAL = "507f1f77bcf86cd799439011",
  PUBLIC = "01909e14-2f56-41f2-afed-21c6f714c805",
  USER = "2d63fe66-f51d-4d3a-a75b-45087857305b"
const query = <T>(value: T) => {
  const result = { lean: async () => value, limit: jest.fn(() => result) }
  return result
}
beforeEach(() => {
  jest.resetAllMocks()
})

it("uses exact internal account lookup and explicit distinct UUID projection without unrelated account data", async () => {
  mockAccount.mockReturnValue(
    query({
      _id: INTERNAL,
      id: PUBLIC,
      kratosUserId: USER,
      defaultWalletId: "actual-default",
    }),
  )
  expect(await ownedWalletSnapshotDependencies().account(INTERNAL as AccountId)).toEqual({
    id: INTERNAL,
    uuid: PUBLIC,
    kratosUserId: USER,
    defaultWalletId: "actual-default",
  })
  expect(mockAccount).toHaveBeenCalledWith(
    { _id: INTERNAL },
    { _id: 1, id: 1, kratosUserId: 1, defaultWalletId: 1 },
  )
})
it("bounds and projects raw wallet-owner metadata with no balance/provider fields", async () => {
  const result = query([
    { id: "usdt-owned", _accountId: INTERNAL, currency: "USDT", type: "checking" },
  ])
  mockWallets.mockReturnValue(result)
  expect(await ownedWalletSnapshotDependencies().wallets(INTERNAL as AccountId)).toEqual([
    { id: "usdt-owned", accountId: INTERNAL, currency: "USDT", type: "checking" },
  ])
  expect(mockWallets).toHaveBeenCalledWith(
    { _accountId: INTERNAL },
    { id: 1, _accountId: 1, currency: 1, type: 1 },
  )
  expect(result.limit).toHaveBeenCalledWith(1001)
})
it("does not manufacture a missing account or stored default", async () => {
  mockAccount
    .mockReturnValueOnce(query(null))
    .mockReturnValueOnce(query({ _id: INTERNAL, id: PUBLIC, kratosUserId: USER }))
  expect(
    await ownedWalletSnapshotDependencies().account(INTERNAL as AccountId),
  ).toBeInstanceOf(Error)
  expect(
    await ownedWalletSnapshotDependencies().account(INTERNAL as AccountId),
  ).toMatchObject({ id: INTERNAL, uuid: PUBLIC, defaultWalletId: undefined })
  expect(mockWallets).not.toHaveBeenCalled()
})
