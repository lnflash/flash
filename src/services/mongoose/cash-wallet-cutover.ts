import { randomUUID } from "crypto"

import { CouldNotUpdateError } from "@domain/errors"

import { parseRepositoryError } from "./utils"
import { CashWalletCutoverConfig, CashWalletMigration } from "./schema"

const CONFIG_ID = "cash_wallet_cutover"

const TERMINAL_STATUSES: CashWalletMigrationStatus[] = [
  "complete",
  "failed",
  "requires_operator_review",
  "skipped_already_migrated",
  "rollback_started",
  "rolled_back",
]

type UpsertMigrationArgs = {
  accountId: AccountId
  accountUuid?: AccountUuid
  legacyUsdWalletId: WalletId
  destinationUsdtWalletId: WalletId
  previousDefaultWalletId?: WalletId
  cutoverVersion: number
  runId: string
  idempotencyKey: string
}

type TransitionMigrationArgs = {
  id: string
  from: CashWalletMigrationStatus
  to: CashWalletMigrationStatus
  cutoverVersion: number
  runId: string
  patch?: Partial<Omit<CashWalletMigration, "id">>
}

type LockMigrationArgs = {
  id: string
  workerId: string
  staleBefore: Date
  cutoverVersion: number
  runId: string
}

type MarkMigrationFailedArgs = Omit<LockMigrationArgs, "staleBefore"> & {
  error: Error
  status: "failed" | "requires_operator_review"
}

const defaultConfig = (): CashWalletCutoverConfig => ({
  state: "pre",
  cutoverVersion: 1,
  updatedAt: new Date(0),
})

const resultToConfig = (
  record: CashWalletCutoverConfigRecord,
): CashWalletCutoverConfig => ({
  state: record.state,
  scheduledAt: record.scheduledAt,
  startedAt: record.startedAt,
  completedAt: record.completedAt,
  pausedAt: record.pausedAt,
  pauseReason: record.pauseReason,
  updatedBy: record.updatedBy,
  cutoverVersion: record.cutoverVersion,
  runId: record.runId,
  updatedAt: record.updatedAt,
})

const resultToMigration = (record: CashWalletMigrationRecord): CashWalletMigration => ({
  id: record._id,
  accountId: record.accountId as AccountId,
  accountUuid: record.accountUuid as AccountUuid | undefined,
  legacyUsdWalletId: record.legacyUsdWalletId as WalletId,
  destinationUsdtWalletId: record.destinationUsdtWalletId as WalletId,
  previousDefaultWalletId: record.previousDefaultWalletId as WalletId | undefined,
  cutoverVersion: record.cutoverVersion,
  runId: record.runId,
  status: record.status,
  sourceBalanceUsdCents: record.sourceBalanceUsdCents,
  destinationAmountUsdtMicros: record.destinationAmountUsdtMicros,
  destinationStartingBalanceUsdtMicros: record.destinationStartingBalanceUsdtMicros,
  feeAmountUsdCents: record.feeAmountUsdCents,
  feeAmountUsdtMicros: record.feeAmountUsdtMicros,
  balanceMoveInvoicePaymentRequest: record.balanceMoveInvoicePaymentRequest,
  balanceMoveInvoicePaymentHash: record.balanceMoveInvoicePaymentHash,
  balanceMovePaymentTransactionId: record.balanceMovePaymentTransactionId,
  feeReimbursementInvoicePaymentRequest: record.feeReimbursementInvoicePaymentRequest,
  feeReimbursementInvoicePaymentHash: record.feeReimbursementInvoicePaymentHash,
  feeReimbursementPaymentTransactionId: record.feeReimbursementPaymentTransactionId,
  estimatedFee: record.estimatedFee,
  idempotencyKey: record.idempotencyKey,
  attempts: record.attempts,
  lastError: record.lastError,
  lockedAt: record.lockedAt,
  lockedBy: record.lockedBy,
  startedAt: record.startedAt,
  completedAt: record.completedAt,
  updatedAt: record.updatedAt,
})

export const CashWalletCutoverRepository = () => {
  const getConfig = async (): Promise<CashWalletCutoverConfig | RepositoryError> => {
    try {
      const result = await CashWalletCutoverConfig.findById(CONFIG_ID)
      if (!result) return defaultConfig()
      return resultToConfig(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const updateConfig = async (
    patch: Partial<CashWalletCutoverConfig>,
    actor?: string,
  ): Promise<CashWalletCutoverConfig | RepositoryError> => {
    try {
      const $set: Record<string, unknown> = { updatedBy: actor, updatedAt: new Date() }
      const $unset: Record<string, 1> = {}

      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          $unset[key] = 1
        } else {
          $set[key] = value
        }
      }

      const update = Object.keys($unset).length > 0 ? { $set, $unset } : { $set }

      const result = await CashWalletCutoverConfig.findOneAndUpdate(
        { _id: CONFIG_ID },
        update,
        { upsert: true, new: true },
      )
      return resultToConfig(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }
      return resultToConfig(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const upsertMigration = async (
    args: UpsertMigrationArgs,
  ): Promise<CashWalletMigration | RepositoryError> => {
    try {
      const now = new Date()
      const result = await CashWalletMigration.findOneAndUpdate(
        { accountId: args.accountId, runId: args.runId },
        {
          $setOnInsert: {
            _id: randomUUID(),
            ...args,
            status: "not_started",
            attempts: 0,
            updatedAt: now,
          },
        },
        { upsert: true, new: true },
      )
      return resultToMigration(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const findMigrationByAccountId = async ({
    accountId,
    cutoverVersion,
    runId,
  }: {
    accountId: AccountId
    cutoverVersion: number
    runId: string
  }): Promise<CashWalletMigration | RepositoryError | null> => {
    try {
      const result = await CashWalletMigration.findOne({
        accountId,
        cutoverVersion,
        runId,
      })
      if (!result) return null
      return resultToMigration(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const transitionMigration = async ({
    id,
    from,
    to,
    cutoverVersion,
    runId,
    patch = {},
  }: TransitionMigrationArgs): Promise<CashWalletMigration | RepositoryError> => {
    try {
      const result = await CashWalletMigration.findOneAndUpdate(
        { _id: id, status: from, cutoverVersion, runId },
        { $set: { ...patch, status: to, updatedAt: new Date() } },
        { new: true },
      )
      if (!result)
        return new CouldNotUpdateError("Could not transition cash wallet migration")
      return resultToMigration(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const acquireMigrationLock = async ({
    id,
    workerId,
    staleBefore,
    cutoverVersion,
    runId,
  }: LockMigrationArgs): Promise<CashWalletMigration | RepositoryError> => {
    try {
      const result = await CashWalletMigration.findOneAndUpdate(
        {
          _id: id,
          cutoverVersion,
          runId,
          $or: [{ lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
        },
        { $set: { lockedAt: new Date(), lockedBy: workerId, updatedAt: new Date() } },
        { new: true },
      )
      if (!result)
        return new CouldNotUpdateError("Could not acquire cash wallet migration lock")
      return resultToMigration(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const releaseMigrationLock = async ({
    id,
    workerId,
    cutoverVersion,
    runId,
  }: Omit<LockMigrationArgs, "staleBefore">): Promise<
    CashWalletMigration | RepositoryError
  > => {
    try {
      const result = await CashWalletMigration.findOneAndUpdate(
        { _id: id, lockedBy: workerId, cutoverVersion, runId },
        { $set: { lockedAt: null, lockedBy: null, updatedAt: new Date() } },
        { new: true },
      )
      if (!result)
        return new CouldNotUpdateError("Could not release cash wallet migration lock")
      return resultToMigration(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const markMigrationFailed = async ({
    id,
    workerId,
    cutoverVersion,
    runId,
    error,
    status,
  }: MarkMigrationFailedArgs): Promise<CashWalletMigration | RepositoryError> => {
    try {
      const result = await CashWalletMigration.findOneAndUpdate(
        { _id: id, lockedBy: workerId, cutoverVersion, runId },
        {
          $set: {
            status,
            lastError: error.message,
            lockedAt: null,
            lockedBy: null,
            updatedAt: new Date(),
          },
          $inc: { attempts: 1 },
        },
        { new: true },
      )
      if (!result)
        return new CouldNotUpdateError("Could not mark cash wallet migration failed")
      return resultToMigration(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const listRunnableMigrations = async ({
    cutoverVersion,
    runId,
    limit,
  }: {
    cutoverVersion: number
    runId: string
    limit?: number
  }): Promise<CashWalletMigration[] | RepositoryError> => {
    try {
      const results = await CashWalletMigration.find({
        cutoverVersion,
        runId,
        status: { $nin: TERMINAL_STATUSES },
      })
        .sort({ updatedAt: 1 })
        .limit(limit ?? 0)
      return results.map(resultToMigration)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const countByStatus = async ({
    cutoverVersion,
    runId,
    status,
  }: {
    cutoverVersion: number
    runId: string
    status: CashWalletMigrationStatus
  }): Promise<number | RepositoryError> => {
    try {
      return CashWalletMigration.countDocuments({ cutoverVersion, runId, status })
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  return {
    getConfig,
    updateConfig,
    upsertMigration,
    findMigrationByAccountId,
    transitionMigration,
    acquireMigrationLock,
    releaseMigrationLock,
    markMigrationFailed,
    listRunnableMigrations,
    countByStatus,
  }
}
