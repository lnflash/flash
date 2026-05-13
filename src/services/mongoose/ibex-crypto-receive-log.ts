import { IbexCryptoReceiveLog } from "./schema"

export const createIbexCryptoReceiveLog = async (data: {
  txHash: string
  address: string
  amount: string
  currency: string
  network: string
  accountId?: string
}): Promise<{ id: string } | Error> => {
  try {
    const log = await IbexCryptoReceiveLog.findOneAndUpdate(
      { txHash: data.txHash },
      { ...data, receivedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )

    return { id: log._id.toString() }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

export const findIbexCryptoReceiveLogsSince = async ({
  since,
  until = new Date(),
}: {
  since: Date
  until?: Date
}): Promise<
  | Array<{
      txHash: string
      address: string
      amount: string
      currency: string
      network: string
      accountId?: string
      receivedAt: Date
    }>
  | Error
> => {
  try {
    return await IbexCryptoReceiveLog.find({
      receivedAt: { $gte: since, $lte: until },
    })
      .sort({ receivedAt: -1 })
      .lean()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
