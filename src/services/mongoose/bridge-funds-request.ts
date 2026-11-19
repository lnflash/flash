import { BridgeFundsRequest } from "./schema"

export type BridgeFundsRequestRecord = {
  fundsRequestId: string
  depositId?: string
  customerId?: string
  amount?: string
  currency?: string
  paymentRail?: string
  fraud: boolean
  noticeDate?: string
  accountId?: string
  erpnextOutcome?: string
  erpnextRecordedAt?: Date
  lockOutcome?: string
  lockDoneAt?: Date
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

// Insert-if-absent. `inserted` is true only for the call that created the
// record, which is what makes "alert once per funds request" hold across runs
// and restarts. Returns the stored record either way.
export const recordFundsRequestSeen = async (data: {
  fundsRequestId: string
  depositId?: string
  customerId?: string
  amount?: string
  currency?: string
  paymentRail?: string
  fraud: boolean
  noticeDate?: string
  raw: unknown
}): Promise<{ inserted: boolean; record: BridgeFundsRequestRecord } | Error> => {
  try {
    const result = await BridgeFundsRequest.updateOne(
      { fundsRequestId: { $eq: data.fundsRequestId } },
      { $setOnInsert: { ...data, firstSeenAt: new Date(), updatedAt: new Date() } },
      { upsert: true },
    )
    const record = await BridgeFundsRequest.findOne({
      fundsRequestId: { $eq: data.fundsRequestId },
    })
      .lean()
      .exec()
    if (!record) return new Error(`Funds request ${data.fundsRequestId} not stored`)

    return {
      inserted: result.upsertedCount === 1,
      record: record as unknown as BridgeFundsRequestRecord,
    }
  } catch (error) {
    return toError(error)
  }
}

export const updateFundsRequestProgress = async (
  fundsRequestId: string,
  update: Partial<
    Pick<
      BridgeFundsRequestRecord,
      "accountId" | "erpnextOutcome" | "erpnextRecordedAt" | "lockOutcome" | "lockDoneAt"
    >
  >,
): Promise<true | Error> => {
  try {
    await BridgeFundsRequest.updateOne(
      { fundsRequestId: { $eq: fundsRequestId } },
      { $set: { ...update, updatedAt: new Date() } },
    )
    return true
  } catch (error) {
    return toError(error)
  }
}
