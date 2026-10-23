jest.mock("@config", () => ({
  getDefaultAccountsConfig: () => ({ initialStatus: "active" }),
  getDefaultFCMTopics: () => ["broadcast"],
}))

const mockJournalFind = jest.fn(),
  mockJournalWrite = jest.fn()
const mockAccountFind = jest.fn(),
  mockAccountWrite = jest.fn(),
  mockAccountUpdate = jest.fn()
const mockUserFind = jest.fn(),
  mockUserUpdate = jest.fn()
const mockWalletFind = jest.fn(),
  mockWalletWrite = jest.fn()
jest.mock("@services/mongoose/schema", () => ({
  DeviceAccountBootstrap: {
    findOne: (...args: unknown[]) => mockJournalFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mockJournalWrite(...args),
  },
  Account: {
    find: (...args: unknown[]) => mockAccountFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mockAccountWrite(...args),
    updateOne: (...args: unknown[]) => mockAccountUpdate(...args),
  },
  User: {
    find: (...args: unknown[]) => mockUserFind(...args),
    updateOne: (...args: unknown[]) => mockUserUpdate(...args),
  },
  Wallet: {
    find: (...args: unknown[]) => mockWalletFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mockWalletWrite(...args),
  },
}))
jest.mock("@services/mongoose/utils", () => ({ toObjectId: (id: string) => id }))

import {
  DeviceBootstrapRepository,
  hasControlledDeviceBootstrap,
} from "@services/mongoose/device-bootstrap"
import type { DeviceBootstrapJournalRecord } from "@domain/accounts/device-bootstrap"
import { DeviceBootstrapError } from "@domain/authentication/device-bootstrap-error"

const USER = "kratos-owner",
  ACCOUNT = "000000000000000000000001",
  HASH = "a".repeat(64)
const record = (): DeviceBootstrapJournalRecord => ({
  _id: HASH,
  version: 1,
  userId: USER,
  accountId: ACCOUNT,
  mode: "new",
  phase: "initializing",
  wallets: { USD: { state: "planned" }, USDT: { state: "planned" } },
  createdAt: new Date(),
  updatedAt: new Date(),
})
const account = {
  _id: ACCOUNT,
  kratosUserId: USER,
  level: 0,
  statusHistory: [{ status: "active" }],
}
const query = <T>(value: T) => {
  const result = {
    lean: jest.fn(async () => value),
    limit: jest.fn(() => result),
  }
  return result
}
const failureCode = async (work: Promise<unknown>, code: string) => {
  try {
    await work
    throw new Error("Expected rejection")
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceBootstrapError)
    expect((error as DeviceBootstrapError).code).toBe(code)
  }
}
beforeEach(() => {
  jest.resetAllMocks()
})

it("reserves immutable owner provenance with majority+j durability before provider dispatch", async () => {
  const journal = record()
  mockJournalWrite.mockReturnValue(query(journal))
  expect(await DeviceBootstrapRepository().reserve(journal)).toEqual(journal)
  expect(mockJournalWrite).toHaveBeenCalledWith(
    { _id: HASH, userId: USER },
    { $setOnInsert: journal },
    {
      upsert: true,
      new: true,
      writeConcern: { w: "majority", j: true },
      setDefaultsOnInsert: false,
    },
  )
  expect(JSON.stringify(mockJournalWrite.mock.calls)).not.toContain("password")
  expect(JSON.stringify(mockJournalWrite.mock.calls)).not.toContain("token")
})

it("uses owner/account/phase/attempt/provider-ID compare-and-set for journal transitions", async () => {
  const journal = record()
  journal.wallets.USD = { state: "dispatching", attemptId: "attempt-owned" }
  const known = {
    state: "known" as const,
    attemptId: "attempt-owned",
    providerId: "provider-owned",
    origin: "created" as const,
  }
  mockJournalWrite.mockReturnValue(
    query({ ...journal, wallets: { ...journal.wallets, USD: known } }),
  )
  await DeviceBootstrapRepository().transition(journal, "USD", journal.wallets.USD, known)
  const [filter, update, options] = mockJournalWrite.mock.calls[0]
  expect(filter).toEqual({
    "_id": HASH,
    "userId": USER,
    "accountId": ACCOUNT,
    "version": 1,
    "mode": "new",
    "phase": "initializing",
    "wallets.USD.state": "dispatching",
    "wallets.USD.attemptId": "attempt-owned",
    "wallets.USD.providerId": { $exists: false },
  })
  expect(update.$set["wallets.USD"]).toEqual(known)
  expect(options.writeConcern).toEqual({ w: "majority", j: true })
  mockJournalWrite.mockReturnValue(query(null))
  await failureCode(
    DeviceBootstrapRepository().transition(journal, "USD", journal.wallets.USD, known),
    "DEVICE_BOOTSTRAP_RETRY_REQUIRED",
  )
})

it("does not initialize existing account fields through an ordinary update", async () => {
  mockAccountWrite.mockReturnValue(
    query({ ...account, level: 2, defaultWalletId: "actual-user-default" }),
  )
  const value = await DeviceBootstrapRepository().ensureAccount(record())
  expect(value.level).toBe(2)
  expect(value.defaultWalletId).toBe("actual-user-default")
  const [filter, update, options] = mockAccountWrite.mock.calls[0]
  expect(filter).toEqual({ _id: ACCOUNT, kratosUserId: USER })
  expect(update.$set).toBeUndefined()
  expect(update.$unset).toBeUndefined()
  expect(update.$setOnInsert.level).toBe(0)
  expect(options.writeConcern).toEqual({ w: "majority", j: true })
})

it("sets only an absent owned trial default and cannot overwrite level/default preferences", async () => {
  mockAccountUpdate.mockResolvedValue({ matchedCount: 0 })
  await DeviceBootstrapRepository().setMissingDefault(record(), "owned-usdt")
  expect(mockAccountUpdate).toHaveBeenCalledWith(
    {
      _id: ACCOUNT,
      kratosUserId: USER,
      level: { $in: [null, 0] },
      defaultWalletId: null,
    },
    { $set: { defaultWalletId: "owned-usdt" } },
    { writeConcern: { w: "majority", j: true } },
  )
})

it("bounds owner discovery and projects no credential or preference fields", async () => {
  const accounts = query([account])
  mockAccountFind.mockReturnValue(accounts)
  expect(await DeviceBootstrapRepository().accounts(USER)).toHaveLength(1)
  expect(mockAccountFind.mock.calls[0][0]).toEqual({ kratosUserId: { $eq: USER } })
  expect(accounts.limit).toHaveBeenCalledWith(2)
  const users = query([{ userId: USER, deviceId: "device", phone: undefined }])
  mockUserFind.mockReturnValue(users)
  expect(await DeviceBootstrapRepository().userBindings(USER, "device")).toEqual([
    { userId: USER, deviceId: "device", hasPhone: false },
  ])
  expect(users.limit).toHaveBeenCalledWith(3)
  expect(mockUserFind.mock.calls[0][1]).toEqual({ userId: 1, deviceId: 1, phone: 1 })
})

it("binds only device metadata and never unsets an existing phone or rewrites language/tokens", async () => {
  mockUserFind.mockReturnValue(query([{ userId: USER }]))
  mockUserUpdate.mockResolvedValue({ matchedCount: 1 })
  await DeviceBootstrapRepository().bindDeviceMetadata(USER, "device")
  const [filter, update] = mockUserUpdate.mock.calls[0]
  expect(filter).toEqual({
    userId: USER,
    deviceId: { $in: [null, "device"] },
    phone: { $in: [null, ""] },
  })
  expect(update).toEqual({ $set: { deviceId: "device" } })
})

it.each(
  [
    [{ userId: "foreign", deviceId: "device" }],
    [{ userId: USER, deviceId: "another-device" }],
    [{ userId: USER, deviceId: "device", phone: "+15550000000" }],
    [{ userId: USER }, { userId: USER }],
  ].map((rows) => ({ rows })),
)(
  "refuses ambiguous/foreign/upgraded user bindings before any metadata write",
  async ({ rows }) => {
    mockUserFind.mockReturnValue(query(rows))
    await failureCode(
      DeviceBootstrapRepository().bindDeviceMetadata(USER, "device"),
      "DEVICE_BOOTSTRAP_OWNER_MISMATCH",
    )
    expect(mockUserUpdate).not.toHaveBeenCalled()
  },
)

it("attaches a known provider ID through owned-only insert predicates without a provider call", async () => {
  const owned = {
    id: "provider-owned",
    _accountId: ACCOUNT,
    currency: "USD",
    type: "checking",
  }
  mockWalletFind.mockReturnValueOnce(query([])).mockReturnValueOnce(query([owned]))
  mockWalletWrite.mockReturnValue(query(owned))
  await DeviceBootstrapRepository().attach(record(), "USD", "provider-owned")
  expect(mockWalletWrite.mock.calls[0][0]).toEqual({
    id: "provider-owned",
    _accountId: ACCOUNT,
    type: "checking",
    currency: "USD",
  })
  expect(mockWalletWrite.mock.calls[0][1]).toEqual({
    $setOnInsert: {
      id: "provider-owned",
      _accountId: ACCOUNT,
      type: "checking",
      currency: "USD",
    },
  })
  expect(mockWalletWrite.mock.calls[0][2].writeConcern).toEqual({
    w: "majority",
    j: true,
  })
})

it.each(
  [
    [{ id: "provider-owned", _accountId: "foreign", currency: "USD", type: "checking" }],
    [{ id: "provider-owned", _accountId: ACCOUNT, currency: "USDT", type: "checking" }],
    [{ id: "provider-owned", _accountId: ACCOUNT, currency: "USD", type: "external" }],
    [
      { id: "provider-owned", _accountId: ACCOUNT, currency: "USD", type: "checking" },
      { id: "provider-owned", _accountId: ACCOUNT, currency: "USD", type: "checking" },
    ],
  ].map((rows) => ({ rows })),
)(
  "does not overwrite a provider ID with conflicting owner/currency/type or duplicate local rows",
  async ({ rows }) => {
    mockWalletFind.mockReturnValue(query(rows))
    await failureCode(
      DeviceBootstrapRepository().attach(record(), "USD", "provider-owned"),
      "DEVICE_BOOTSTRAP_OWNER_MISMATCH",
    )
    expect(mockWalletWrite).not.toHaveBeenCalled()
  },
)

it("marks readiness only for the owned exact attached IDs", async () => {
  const journal = record()
  journal.wallets.USD = { state: "attached", origin: "local", providerId: "usd-owned" }
  journal.wallets.USDT = { state: "attached", origin: "local", providerId: "usdt-owned" }
  mockJournalWrite.mockReturnValue(query({ ...journal, phase: "ready" }))
  await DeviceBootstrapRepository().ready(journal)
  expect(mockJournalWrite.mock.calls[0][0]).toEqual({
    "_id": HASH,
    "userId": USER,
    "accountId": ACCOUNT,
    "version": 1,
    "mode": "new",
    "phase": "initializing",
    "wallets.USD.state": "attached",
    "wallets.USDT.state": "attached",
    "wallets.USD.providerId": "usd-owned",
    "wallets.USDT.providerId": "usdt-owned",
  })
})

it("suppresses public autoheal for any journal claiming this account, independent of schema or current phase", async () => {
  mockJournalFind
    .mockReturnValueOnce(query({ _id: HASH }))
    .mockReturnValueOnce(query(null))
  expect(await hasControlledDeviceBootstrap(ACCOUNT)).toBe(true)
  expect(await hasControlledDeviceBootstrap("ordinary-phone-account")).toBe(false)
  expect(mockJournalFind.mock.calls[0]).toEqual([
    { accountId: { $eq: ACCOUNT } },
    { _id: 1 },
  ])
})
