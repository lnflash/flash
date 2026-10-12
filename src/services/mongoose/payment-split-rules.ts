import { parseRepositoryError } from "./utils"
import { PaymentSplitRule as PaymentSplitRuleModel } from "./schema"

export type PaymentSplitRuleRecord = {
  id: string
  walletId: string
  destinationWalletId: string
  percent: number
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

type RawRule = {
  _id: { toString(): string }
  walletId: string
  destinationWalletId: string
  percent: number
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

// Typed RepositoryErrors, so every failure maps cleanly through error-map.
const toError = (error: unknown): RepositoryError => parseRepositoryError(error)

const toRule = (raw: RawRule): PaymentSplitRuleRecord => ({
  id: raw._id.toString(),
  walletId: raw.walletId,
  destinationWalletId: raw.destinationWalletId,
  percent: raw.percent,
  enabled: raw.enabled,
  createdAt: raw.createdAt,
  updatedAt: raw.updatedAt,
})

export const PaymentSplitRulesRepository = () => {
  const listByWalletId = async (
    walletId: string,
    { enabledOnly = false }: { enabledOnly?: boolean } = {},
  ): Promise<PaymentSplitRuleRecord[] | RepositoryError> => {
    try {
      const filter: Record<string, unknown> = { walletId: { $eq: walletId } }
      if (enabledOnly) filter.enabled = true
      const docs = await PaymentSplitRuleModel.find(filter)
        .sort({ createdAt: 1 })
        .lean<RawRule[]>()
        .exec()
      return docs.map(toRule)
    } catch (error) {
      return toError(error)
    }
  }

  const findById = async (
    id: string,
  ): Promise<PaymentSplitRuleRecord | null | RepositoryError> => {
    try {
      if (!/^[0-9a-f]{24}$/i.test(id)) return null
      const doc = await PaymentSplitRuleModel.findById(id).lean<RawRule>().exec()
      return doc ? toRule(doc) : null
    } catch (error) {
      return toError(error)
    }
  }

  // Replace semantics: the new set becomes the wallet's whole rule set. Callers
  // hold the wallet lock so two concurrent replaces cannot interleave.
  //
  // createdAt is carried forward for every destination that survives the
  // replace; only a destination new to the set gets createdAt = now. The
  // recorder skips receives that settled before a rule's createdAt, so
  // re-stamping an unchanged destination on every save would drop a receive
  // that settled before the save but was not yet recorded (a webhook whose
  // record failed, waiting for the reconcile).
  const replaceForWallet = async (
    walletId: string,
    rules: { destinationWalletId: string; percent: number }[],
    { now = new Date() }: { now?: Date } = {},
  ): Promise<PaymentSplitRuleRecord[] | RepositoryError> => {
    try {
      const existing = await PaymentSplitRuleModel.find({ walletId: { $eq: walletId } })
        .lean<RawRule[]>()
        .exec()
      const createdAtByDestination = new Map<string, Date>()
      for (const rule of existing) {
        const known = createdAtByDestination.get(rule.destinationWalletId)
        if (!known || rule.createdAt.getTime() < known.getTime()) {
          createdAtByDestination.set(rule.destinationWalletId, rule.createdAt)
        }
      }

      await PaymentSplitRuleModel.deleteMany({ walletId: { $eq: walletId } })
      if (rules.length === 0) return []
      const docs = await PaymentSplitRuleModel.insertMany(
        rules.map(({ destinationWalletId, percent }) => ({
          walletId,
          destinationWalletId,
          percent,
          enabled: true,
          createdAt: createdAtByDestination.get(destinationWalletId) ?? now,
          updatedAt: now,
        })),
      )
      return docs.map((doc) => toRule(doc.toObject() as unknown as RawRule))
    } catch (error) {
      return toError(error)
    }
  }

  const deleteById = async (id: string): Promise<boolean | RepositoryError> => {
    try {
      const result = await PaymentSplitRuleModel.deleteOne({ _id: id })
      return result.deletedCount > 0
    } catch (error) {
      return toError(error)
    }
  }

  // ENG-660: turns off every enabled rule from `walletId` to a destination
  // whose account went inactive. Matched by (wallet, destination), not by rule
  // id: replaceForWallet re-inserts every rule with a new _id on each save, so
  // an execution's ruleId may name a rule that no longer exists while a
  // replacement to the same dead destination is still enabled. Only enabled
  // rules are updated, so of several executions failing on the same
  // destination exactly one sees `true` and notifies the owner.
  const disableForDestination = async (
    walletId: string,
    destinationWalletId: string,
    { now = new Date() }: { now?: Date } = {},
  ): Promise<boolean | RepositoryError> => {
    try {
      const result = await PaymentSplitRuleModel.updateMany(
        {
          walletId: { $eq: walletId },
          destinationWalletId: { $eq: destinationWalletId },
          enabled: true,
        },
        { $set: { enabled: false, updatedAt: now } },
      )
      return result.modifiedCount > 0
    } catch (error) {
      return toError(error)
    }
  }

  // Whether any rule (enabled or not) from `walletId` to `destinationWalletId`
  // exists.
  const existsForDestination = async (
    walletId: string,
    destinationWalletId: string,
  ): Promise<boolean | RepositoryError> => {
    try {
      const doc = await PaymentSplitRuleModel.exists({
        walletId: { $eq: walletId },
        destinationWalletId: { $eq: destinationWalletId },
      })
      return doc !== null
    } catch (error) {
      return toError(error)
    }
  }

  const listWalletIdsWithEnabledRules = async (): Promise<string[] | RepositoryError> => {
    try {
      const ids = await PaymentSplitRuleModel.distinct("walletId", { enabled: true })
      return ids.map(String)
    } catch (error) {
      return toError(error)
    }
  }

  return {
    listByWalletId,
    findById,
    replaceForWallet,
    deleteById,
    disableForDestination,
    existsForDestination,
    listWalletIdsWithEnabledRules,
  }
}
