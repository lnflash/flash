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
  const replaceForWallet = async (
    walletId: string,
    rules: { destinationWalletId: string; percent: number }[],
  ): Promise<PaymentSplitRuleRecord[] | RepositoryError> => {
    try {
      await PaymentSplitRuleModel.deleteMany({ walletId: { $eq: walletId } })
      if (rules.length === 0) return []
      const now = new Date()
      const docs = await PaymentSplitRuleModel.insertMany(
        rules.map(({ destinationWalletId, percent }) => ({
          walletId,
          destinationWalletId,
          percent,
          enabled: true,
          createdAt: now,
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
    listWalletIdsWithEnabledRules,
  }
}
