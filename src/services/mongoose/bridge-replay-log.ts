import { BridgeReplayLog } from "./schema"

export const createBridgeReplayLog = async (data: {
  eventId: string
  eventType: string
  eventPayload: Record<string, unknown>
  bridgeEventCreatedAt: Date
  replayedAt: Date
  operator: string
  timeWindowStart: Date
  timeWindowEnd: Date
  httpStatus: number
  httpResponse: Record<string, unknown>
  dryRun?: boolean
}): Promise<{ id: string } | Error> => {
  try {
    const log = await BridgeReplayLog.create(data)

    return { id: log._id.toString() }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

export const findBridgeReplayLogs = async (filter?: {
  eventType?: string
  dryRun?: boolean
  limit?: number
}): Promise<unknown[] | Error> => {
  try {
    const queryFilter: Record<string, unknown> = {}
    if (filter?.eventType !== undefined) queryFilter.eventType = filter.eventType
    if (filter?.dryRun !== undefined) queryFilter.dryRun = filter.dryRun

    return await BridgeReplayLog.find(queryFilter)
      .sort({ replayedAt: -1 })
      .limit(filter?.limit ?? 100)
      .lean()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
