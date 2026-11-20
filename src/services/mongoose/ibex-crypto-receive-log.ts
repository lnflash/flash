import { IbexCryptoReceive } from "./schema"

export const createIbexCryptoReceive = async (data: {
  txHash: string
  address: string
  amount: string
  currency: string
  network: string
  accountId?: string
  ibexTransactionId?: string
}): Promise<{ id: string } | Error> => {
  try {
    const log = await IbexCryptoReceive.findOneAndUpdate(
      { txHash: data.txHash },
      { ...data, receivedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )

    return { id: log._id.toString() }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

export const findIbexCryptoReceivesSince = async ({
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
    return await IbexCryptoReceive.find({
      receivedAt: { $gte: since, $lte: until },
    })
      .sort({ receivedAt: -1 })
      .lean()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

export const isIbexCryptoReceiveProcessed = async (
  txHash: string,
): Promise<boolean | Error> => {
  try {
    const found = await IbexCryptoReceive.exists({
      txHash,
      processedAt: { $exists: true },
    })
    return Boolean(found)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

export const markIbexCryptoReceiveProcessed = async (
  txHash: string,
): Promise<true | Error> => {
  try {
    await IbexCryptoReceive.updateOne({ txHash }, { $set: { processedAt: new Date() } })
    return true
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

// Lowercased tx hashes, out of `txHashes`, whose receive finished processing.
export const findProcessedIbexCryptoReceiveTxHashes = async (
  txHashes: string[],
): Promise<Set<string> | Error> => {
  if (txHashes.length === 0) return new Set()
  try {
    const variants = [...new Set(txHashes.flatMap((h) => [h, h.toLowerCase()]))]
    const rows = await IbexCryptoReceive.find(
      { txHash: { $in: variants }, processedAt: { $exists: true } },
      { txHash: 1 },
    ).lean()
    return new Set(rows.map((r) => String(r.txHash).toLowerCase()))
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
