import { parseRepositoryError } from "./utils"
import { PaymentSplitExecution as PaymentSplitExecutionModel } from "./schema"

export type PaymentSplitExecutionStatusValue =
  | "pending"
  | "sending"
  | "sent"
  | "ibex_pending"
  | "failed"
  | "skipped_min"
  | "skipped_internal"
  | "unknown"

export type PaymentSplitExecutionRecord = {
  id: string
  triggerKey: string
  ruleId: string
  walletId: string
  destinationWalletId: string
  currency: string
  triggerAmountMinor: string
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
  walletId: raw.walletId,
  destinationWalletId: raw.destinationWalletId,
  currency: raw.currency,
  triggerAmountMinor: raw.triggerAmountMinor,
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
   * Inserts one execution. A duplicate (triggerKey, walletId,
   * destinationWalletId) — a webhook replay, or the reconcile cron finding a
   * receive the webhook already recorded, even under a rule rewritten since —
   * is a typed no-op: `{ inserted: false }`.
   */
  const insert = async (data: {
    triggerKey: string
    ruleId: string
    walletId: string
    destinationWalletId: string
    currency: string
    triggerAmountMinor: string
    shareCents: number
    status: "pending" | "skipped_min"
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
      status:
        | "pending"
        | "sent"
        | "ibex_pending"
        | "failed"
        | "skipped_internal"
        | "unknown"
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

  return { insert, claimNextDue, finishClaimed, markNextStaleUnknown }
}
