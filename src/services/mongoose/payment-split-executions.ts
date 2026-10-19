import { parseRepositoryError } from "./utils"
import { PaymentSplitExecution as PaymentSplitExecutionModel } from "./schema"

export type PaymentSplitExecutionStatusValue =
  | "pending"
  | "sending"
  | "sent"
  | "ibex_pending"
  | "failed"
  | "unknown"

export type PaymentSplitExecutionRecord = {
  id: string
  triggerKey: string
  ruleId: string
  legKind: "share" | "net"
  walletId: string
  sourceIbexAccountId: string
  destinationWalletId: string
  currency: string
  grossMinor: string
  shareCents: number
  status: PaymentSplitExecutionStatusValue
  attempts: number
  nextAttemptAt: Date
  lastError?: string
  createdAt: Date
  updatedAt: Date
}

type RawExecution = Omit<PaymentSplitExecutionRecord, "id"> & {
  _id: { toString(): string }
}

const isDuplicateKeyError = (error: unknown): boolean =>
  (error as { code?: number } | null)?.code === 11000

// Typed RepositoryErrors, so every failure maps cleanly through error-map.
const toError = (error: unknown): RepositoryError => parseRepositoryError(error)

const toExecution = (raw: RawExecution): PaymentSplitExecutionRecord => ({
  id: raw._id.toString(),
  triggerKey: raw.triggerKey,
  ruleId: raw.ruleId,
  legKind: raw.legKind,
  walletId: raw.walletId,
  sourceIbexAccountId: raw.sourceIbexAccountId,
  destinationWalletId: raw.destinationWalletId,
  currency: raw.currency,
  grossMinor: raw.grossMinor,
  shareCents: raw.shareCents,
  status: raw.status,
  attempts: raw.attempts,
  nextAttemptAt: raw.nextAttemptAt,
  lastError: raw.lastError,
  createdAt: raw.createdAt,
  updatedAt: raw.updatedAt,
})

export const PaymentSplitExecutionsRepository = () => {
  /**
   * Inserts one leg. A duplicate (triggerKey, legKind, destinationWalletId) —
   * a webhook replay, or the reconcile cron finding a receive the webhook
   * already built, even under a rule rewritten since — is a typed no-op:
   * `{ inserted: false }`.
   */
  const insert = async (data: {
    triggerKey: string
    legKind: "share" | "net"
    ruleId: string
    walletId: string
    sourceIbexAccountId: string
    destinationWalletId: string
    currency: string
    grossMinor: string
    shareCents: number
    status: "pending"
    nextAttemptAt?: Date
    now?: Date
  }): Promise<{ inserted: true; id: string } | { inserted: false } | RepositoryError> => {
    const { now = new Date(), nextAttemptAt = now, ...fields } = data
    try {
      const doc = await PaymentSplitExecutionModel.create({
        ...fields,
        attempts: 0,
        nextAttemptAt,
        createdAt: now,
        updatedAt: now,
      })
      return { inserted: true, id: doc._id.toString() }
    } catch (error) {
      if (isDuplicateKeyError(error)) return { inserted: false }
      return toError(error)
    }
  }

  /**
   * ENG-717 decision 2 (fold, never fail): tops the merchant up for a share
   * leg that failed terminally. Inserts one `share`-kind row keyed on the
   * MERCHANT as destination for the same trigger: unique against the
   * settle-time net row (different legKind) and against the original share
   * row (different destination). One fold per (trigger, destination): a
   * replayed fold is a duplicate-key no-op. The fold row is claimable at
   * `now` — no claimGraceMs, the trigger receive already settled.
   */
  const insertFold = async (
    execution: {
      triggerKey: string
      ruleId: string
      walletId: string
      sourceIbexAccountId: string
      currency: string
      grossMinor: string
      shareCents: number
    },
    reason: string,
    now: Date = new Date(),
  ): Promise<boolean | RepositoryError> => {
    try {
      await PaymentSplitExecutionModel.create({
        triggerKey: execution.triggerKey,
        legKind: "share",
        ruleId: execution.ruleId,
        walletId: execution.walletId,
        sourceIbexAccountId: execution.sourceIbexAccountId,
        destinationWalletId: execution.walletId,
        currency: execution.currency,
        grossMinor: execution.grossMinor,
        shareCents: execution.shareCents,
        status: "pending",
        attempts: 0,
        lastError: `fold: ${reason}`,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      return true
    } catch (error) {
      // The share was already folded (an earlier attempt folded it, or the
      // settle-time net leg covers it): nothing more to pay.
      if (isDuplicateKeyError(error)) return false
      return toError(error)
    }
  }

  /**
   * Atomically moves one due (nextAttemptAt <= `now`) `pending` row to
   * `sending`. Two concurrent claimers can never both get the same row:
   * findOneAndUpdate matches on the status it is changing.
   *
   * The claim is stamped with `claimedAt` (wall-clock time by default), not
   * `now`: the stale sweep reads updatedAt as "claimed at", and a stale `now`
   * would let another replica's sweep take a row that is still being paid.
   */
  const claimNextDue = async (
    now: Date,
    claimedAt: Date = new Date(),
  ): Promise<PaymentSplitExecutionRecord | null | RepositoryError> => {
    try {
      const doc = await PaymentSplitExecutionModel.findOneAndUpdate(
        { status: "pending", nextAttemptAt: { $lte: now } },
        { $set: { status: "sending", updatedAt: claimedAt } },
        { sort: { nextAttemptAt: 1 }, new: true },
      )
        .lean<RawExecution>()
        .exec()
      return doc ? toExecution(doc) : null
    } catch (error) {
      return toError(error)
    }
  }

  // Records the outcome of a claimed row. Matches on `sending` so a row the
  // stale sweep already moved to `unknown` is never overwritten.
  const finishClaimed = async (
    id: string,
    update: {
      status: "pending" | "sent" | "ibex_pending" | "failed" | "unknown"
      attempts: number
      nextAttemptAt?: Date
      lastError?: string
      now?: Date
    },
  ): Promise<boolean | RepositoryError> => {
    const { now = new Date(), ...fields } = update
    try {
      const result = await PaymentSplitExecutionModel.updateOne(
        { _id: id, status: "sending" },
        { $set: { ...fields, updatedAt: now } },
      )
      return result.modifiedCount > 0
    } catch (error) {
      return toError(error)
    }
  }

  // Moves one row stuck in `sending` since before `cutoff` to `unknown`.
  const markNextStaleUnknown = async (
    cutoff: Date,
    now: Date,
  ): Promise<PaymentSplitExecutionRecord | null | RepositoryError> => {
    try {
      const doc = await PaymentSplitExecutionModel.findOneAndUpdate(
        { status: "sending", updatedAt: { $lt: cutoff } },
        { $set: { status: "unknown", updatedAt: now } },
        { new: true },
      )
        .lean<RawExecution>()
        .exec()
      return doc ? toExecution(doc) : null
    } catch (error) {
      return toError(error)
    }
  }

  return { insert, insertFold, claimNextDue, finishClaimed, markNextStaleUnknown }
}
