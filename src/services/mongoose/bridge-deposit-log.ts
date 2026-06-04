import { BridgeDeposits } from "./schema"

export const createBridgeDeposit = async (data: {
  eventId: string
  transferId: string
  customerId: string
  state: string
  amount: string
  currency: string
  developerFee: string
  subtotalAmount?: string
  initialAmount?: string
  finalAmount?: string
  destinationTxHash?: string
}): Promise<{ id: string } | Error> => {
  try {
    const log = await BridgeDeposits.findOneAndUpdate(
      { eventId: data.eventId },
      { $setOnInsert: data },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    return { id: log._id.toString() }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
