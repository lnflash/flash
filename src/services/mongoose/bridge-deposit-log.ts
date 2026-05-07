import { BridgeDepositLog } from "./schema"

export const createBridgeDepositLog = async (data: {
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
    const log = await BridgeDepositLog.create(data)
    return { id: log._id.toString() }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
