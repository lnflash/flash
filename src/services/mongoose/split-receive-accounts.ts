import { parseRepositoryError } from "./utils"
import { SplitReceiveAccount as SplitReceiveAccountModel } from "./schema"

export type SplitReceiveAccountRecord = {
  walletId: string
  ibexAccountId: string
  currency: string
  lnurlp?: string
  createdAt: Date
  updatedAt: Date
}

type RawRecord = Omit<SplitReceiveAccountRecord, "id"> & {
  _id: { toString(): string }
}

const isDuplicateKeyError = (error: unknown): boolean =>
  (error as { code?: number } | null)?.code === 11000

// Typed RepositoryErrors, so every failure maps cleanly through error-map.
const toError = (error: unknown): RepositoryError => parseRepositoryError(error)

const toRecord = (raw: RawRecord): SplitReceiveAccountRecord => ({
  walletId: raw.walletId,
  ibexAccountId: raw.ibexAccountId,
  currency: raw.currency,
  lnurlp: raw.lnurlp,
  createdAt: raw.createdAt,
  updatedAt: raw.updatedAt,
})

export const SplitReceiveAccountsRepository = () => {
  // ENG-717 decision 4: the shadow is permanent. A second ensure for the same
  // wallet (every walletSplitsSet after the first) is a typed no-op, so the
  // IBEX account and LNURL are created exactly once.
  const insert = async (data: {
    walletId: string
    ibexAccountId: string
    currency: string
    lnurlp?: string
    now?: Date
  }): Promise<{ created: true } | { created: false } | RepositoryError> => {
    const { now = new Date(), ...fields } = data
    try {
      await SplitReceiveAccountModel.create({
        ...fields,
        createdAt: now,
        updatedAt: now,
      })
      return { created: true }
    } catch (error) {
      if (isDuplicateKeyError(error)) return { created: false }
      return toError(error)
    }
  }

  const findByWalletId = async (
    walletId: string,
  ): Promise<SplitReceiveAccountRecord | null | RepositoryError> => {
    try {
      const doc = await SplitReceiveAccountModel.findOne({
        walletId: { $eq: walletId },
      })
        .lean<RawRecord>()
        .exec()
      return doc ? toRecord(doc) : null
    } catch (error) {
      return toError(error)
    }
  }

  const findByIbexAccountId = async (
    ibexAccountId: string,
  ): Promise<SplitReceiveAccountRecord | null | RepositoryError> => {
    try {
      const doc = await SplitReceiveAccountModel.findOne({
        ibexAccountId: { $eq: ibexAccountId },
      })
        .lean<RawRecord>()
        .exec()
      return doc ? toRecord(doc) : null
    } catch (error) {
      return toError(error)
    }
  }

  // Every shadow ever created. The reconcile scans them all: one with a
  // balance and no in-flight legs is either a missed webhook (build legs) or
  // residue (alert, then drain per the lifecycle rule).
  const listAll = async (): Promise<SplitReceiveAccountRecord[] | RepositoryError> => {
    try {
      const docs = await SplitReceiveAccountModel.find({})
        .sort({ createdAt: 1 })
        .lean<RawRecord[]>()
        .exec()
      return docs.map(toRecord)
    } catch (error) {
      return toError(error)
    }
  }

  return { insert, findByWalletId, findByIbexAccountId, listAll }
}
