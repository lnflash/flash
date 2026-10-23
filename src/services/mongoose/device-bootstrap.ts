import { getDefaultAccountsConfig, getDefaultFCMTopics } from "@config"
import type {
  BootstrapAccount,
  BootstrapSlot,
  BootstrapWallet,
  DeviceBootstrapJournalRecord,
  DeviceBootstrapStore,
} from "@domain/accounts/device-bootstrap"
import { DeviceBootstrapError } from "@domain/authentication/device-bootstrap-error"

import { Account, DeviceAccountBootstrap, User, Wallet } from "./schema"
import { toObjectId } from "./utils"

const durable = { w: "majority" as const, j: true }
const failure = (code: ConstructorParameters<typeof DeviceBootstrapError>[0]) =>
  new DeviceBootstrapError(code)
const support = () => failure("DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
const owner = () => failure("DEVICE_BOOTSTRAP_OWNER_MISMATCH")
const safe = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    throw error instanceof DeviceBootstrapError
      ? error
      : failure("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
  }
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[^A-Za-z0-9_-]/.test(value)
const slot = (value: BootstrapSlot): boolean => {
  if (
    !value ||
    !["planned", "dispatching", "known", "attached", "blocked"].includes(value.state)
  )
    return false
  if (value.attemptId !== undefined && !identifier(value.attemptId)) return false
  if (value.providerId !== undefined && !identifier(value.providerId)) return false
  if (value.state === "planned")
    return value.attemptId === undefined && value.providerId === undefined
  if (value.state === "dispatching")
    return value.attemptId !== undefined && value.providerId === undefined
  if (value.state === "known")
    return (
      value.attemptId !== undefined &&
      value.providerId !== undefined &&
      value.origin === "created"
    )
  if (value.state === "attached")
    return (
      value.providerId !== undefined && ["created", "local"].includes(value.origin ?? "")
    )
  return true
}
const journal = (
  value: DeviceBootstrapJournalRecord | null,
): DeviceBootstrapJournalRecord | null => {
  if (!value) return null
  if (
    value.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(value._id) ||
    !identifier(value.userId) ||
    !/^[a-f0-9]{24}$/.test(value.accountId) ||
    !["new", "legacy-local"].includes(value.mode) ||
    !["initializing", "ready"].includes(value.phase) ||
    !slot(value.wallets?.USD) ||
    !slot(value.wallets?.USDT)
  )
    throw support()
  return value
}
const account = (value: {
  _id: unknown
  kratosUserId?: string
  level?: number
  defaultWalletId?: string
  statusHistory?: { status: string }[]
}): BootstrapAccount => {
  const id = String(value._id)
  const status = value.statusHistory?.at(-1)?.status
  if (
    !/^[a-f0-9]{24}$/.test(id) ||
    !identifier(value.kratosUserId) ||
    !status ||
    !["new", "pending", "active", "locked", "closed"].includes(status) ||
    (value.level !== undefined && ![0, 1, 2, 3].includes(value.level))
  )
    throw support()
  return {
    id,
    userId: value.kratosUserId,
    level: value.level,
    status,
    defaultWalletId: value.defaultWalletId,
  }
}
const wallet = (value: {
  id: string
  _accountId: unknown
  currency: string
  type: string
}): BootstrapWallet => {
  if (!identifier(value.id) || !["checking", "external"].includes(value.type))
    throw support()
  return {
    id: value.id,
    accountId: String(value._accountId),
    currency: value.currency,
    type: value.type,
  }
}
const ownerFilter = (record: DeviceBootstrapJournalRecord) => ({
  _id: record._id,
  userId: record.userId,
  accountId: record.accountId,
  version: 1,
  mode: record.mode,
})
const projectedAccount = {
  "_id": 1,
  "kratosUserId": 1,
  "level": 1,
  "defaultWalletId": 1,
  "statusHistory.status": 1,
}

/** Durable journal updates and narrow local writes only. Never calls IBEX. */
export const DeviceBootstrapRepository = (): DeviceBootstrapStore => ({
  journal: (key) =>
    safe(async () => journal(await DeviceAccountBootstrap.findOne({ _id: key }).lean())),
  reserve: (record) =>
    safe(async () => {
      const result = journal(
        await DeviceAccountBootstrap.findOneAndUpdate(
          { _id: record._id, userId: record.userId },
          { $setOnInsert: record },
          { upsert: true, new: true, writeConcern: durable, setDefaultsOnInsert: false },
        ).lean(),
      )
      if (!result) throw support()
      return result
    }),
  accounts: (userId) =>
    safe(async () => {
      const records = await Account.find(
        { kratosUserId: { $eq: userId } },
        projectedAccount,
      )
        .limit(2)
        .lean()
      return records.map(account)
    }),
  userBindings: (userId, deviceId) =>
    safe(async () => {
      const records = await User.find(
        { $or: [{ userId: { $eq: userId } }, { deviceId: { $eq: deviceId } }] },
        { userId: 1, deviceId: 1, phone: 1 },
      )
        .limit(3)
        .lean()
      return records.map((record) => ({
        userId: record.userId,
        deviceId: record.deviceId,
        hasPhone:
          record.phone !== undefined && record.phone !== null && record.phone !== "",
      }))
    }),
  bindDeviceMetadata: (userId, deviceId) =>
    safe(async () => {
      const records = await User.find(
        { $or: [{ userId: { $eq: userId } }, { deviceId: { $eq: deviceId } }] },
        { userId: 1, deviceId: 1, phone: 1 },
      )
        .limit(3)
        .lean()
      if (
        records.length > 1 ||
        records.some(
          (record) =>
            record.userId !== userId ||
            (record.deviceId !== undefined && record.deviceId !== deviceId) ||
            !!record.phone,
        )
      )
        throw owner()
      if (records.length === 0) {
        await User.updateOne(
          { userId },
          {
            $setOnInsert: { userId, deviceId, notificationTopics: getDefaultFCMTopics() },
          },
          { upsert: true, writeConcern: durable },
        )
      } else {
        const result = await User.updateOne(
          { userId, deviceId: { $in: [null, deviceId] }, phone: { $in: [null, ""] } },
          { $set: { deviceId } },
          { writeConcern: durable },
        )
        if (result.matchedCount !== 1) throw owner()
      }
    }),
  ensureAccount: (record) =>
    safe(async () => {
      const value = await Account.findOneAndUpdate(
        { _id: toObjectId(record.accountId), kratosUserId: record.userId },
        {
          $setOnInsert: {
            kratosUserId: record.userId,
            level: 0,
            role: "user",
            contactEnabled: true,
            statusHistory: [
              {
                status: getDefaultAccountsConfig().initialStatus,
                comment: "Initial device account status",
              },
            ],
          },
        },
        { upsert: true, new: true, writeConcern: durable, runValidators: true },
      ).lean()
      if (!value) throw owner()
      return account(value)
    }),
  wallets: (accountId) =>
    safe(async () => {
      const records = await Wallet.find(
        { _accountId: toObjectId(accountId) },
        { id: 1, _accountId: 1, type: 1, currency: 1 },
      )
        .limit(1001)
        .lean()
      if (records.length > 1000) throw support()
      return records.map(wallet)
    }),
  attach: (record, currency, providerId) =>
    safe(async () => {
      const before = await Wallet.find(
        { id: { $eq: providerId } },
        { id: 1, _accountId: 1, type: 1, currency: 1 },
      )
        .limit(2)
        .lean()
      if (
        before.length > 1 ||
        before.some(
          (value) =>
            String(value._accountId) !== record.accountId ||
            value.currency !== currency ||
            value.type !== "checking",
        )
      )
        throw owner()
      const result = await Wallet.findOneAndUpdate(
        {
          id: providerId,
          _accountId: toObjectId(record.accountId),
          type: "checking",
          currency,
        },
        {
          $setOnInsert: {
            id: providerId,
            _accountId: toObjectId(record.accountId),
            type: "checking",
            currency,
          },
        },
        { upsert: true, new: true, writeConcern: durable, runValidators: true },
      ).lean()
      if (
        !result ||
        String(result._accountId) !== record.accountId ||
        result.id !== providerId ||
        result.currency !== currency ||
        result.type !== "checking"
      )
        throw owner()
      const after = await Wallet.find(
        { id: { $eq: providerId } },
        { id: 1, _accountId: 1, type: 1, currency: 1 },
      )
        .limit(2)
        .lean()
      if (
        after.length !== 1 ||
        String(after[0]._accountId) !== record.accountId ||
        after[0].currency !== currency ||
        after[0].type !== "checking"
      )
        throw owner()
    }),
  transition: (record, currency, from, to) =>
    safe(async () => {
      if (!slot(from) || !slot(to)) throw support()
      const prefix = `wallets.${currency}`
      const filter = {
        ...ownerFilter(record),
        phase: "initializing",
        [`${prefix}.state`]: from.state,
        [`${prefix}.attemptId`]: from.attemptId ?? { $exists: false },
        [`${prefix}.providerId`]: from.providerId ?? { $exists: false },
      }
      const value = journal(
        await DeviceAccountBootstrap.findOneAndUpdate(
          filter,
          { $set: { [prefix]: to, updatedAt: new Date() } },
          { new: true, writeConcern: durable, runValidators: true },
        ).lean(),
      )
      if (!value) throw failure("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
      return value
    }),
  setMissingDefault: (record, walletId) =>
    safe(async () => {
      const result = await Account.updateOne(
        {
          _id: toObjectId(record.accountId),
          kratosUserId: record.userId,
          level: { $in: [null, 0] },
          defaultWalletId: null,
        },
        { $set: { defaultWalletId: walletId } },
        { writeConcern: durable },
      )
      // A valid concurrent preference wins. The engine's fresh read decides
      // readiness; this operation never overwrites a nonmissing default.
      if (result.matchedCount > 1) throw owner()
    }),
  ready: (record) =>
    safe(async () => {
      const value = journal(
        await DeviceAccountBootstrap.findOneAndUpdate(
          {
            ...ownerFilter(record),
            "phase": "initializing",
            "wallets.USD.state": "attached",
            "wallets.USDT.state": "attached",
            "wallets.USD.providerId": record.wallets.USD.providerId,
            "wallets.USDT.providerId": record.wallets.USDT.providerId,
          },
          { $set: { phase: "ready", updatedAt: new Date() } },
          { new: true, writeConcern: durable },
        ).lean(),
      )
      if (!value) throw failure("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
      return value
    }),
})

/** Read-only suppression guard. Caller holds the existing account lock; never
 * nests it. It deliberately survives trial→phone schema/level upgrades. */
export const hasControlledDeviceBootstrap = (accountId: string): Promise<boolean> =>
  safe(async () => {
    const value = await DeviceAccountBootstrap.findOne(
      { accountId: { $eq: accountId } },
      { _id: 1 },
    ).lean()
    return value !== null
  })
