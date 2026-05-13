#!/usr/bin/env node

/**
 * Operator tool: replay missed Bridge webhook events.
 *
 * Usage:
 *   BRIDGE_WEBHOOK_REPLAY_SECRET=<secret> BRIDGE_WEBHOOK_URL=http://localhost:4009 \
 *     node lib/scripts/replay-bridge-events.js \
 *       --configPath dev/config/base-config.yaml \
 *       --start 2026-05-01T00:00:00Z \
 *       --end   2026-05-02T00:00:00Z \
 *       [--event-type kyc|deposit|transfer] \
 *       [--dry-run] \
 *       [--operator "ops@example.com"]
 */

import { listAllEvents } from "@services/bridge/client"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"

const args = yargs(hideBin(process.argv))
  .option("start", { type: "string", demandOption: true })
  .option("end", { type: "string", demandOption: true })
  .option("event-type", { type: "string", choices: ["kyc", "deposit", "transfer"] })
  .option("transfer-id", {
    type: "string",
    describe: "Replay only events for this transfer ID",
  })
  .option("dry-run", { type: "boolean", default: false })
  .option("operator", { type: "string", default: "unknown" })
  .option("configPath", { type: "string", demandOption: true })
  .parseSync()

const REPLAY_SECRET = process.env.BRIDGE_WEBHOOK_REPLAY_SECRET
const WEBHOOK_URL = process.env.BRIDGE_WEBHOOK_URL ?? "http://localhost:4009"

if (!REPLAY_SECRET) {
  console.error("Error: BRIDGE_WEBHOOK_REPLAY_SECRET environment variable is required")
  process.exit(1)
}

const EVENT_TYPE_FILTER: Record<string, string> = {
  kyc: "kyc.approved",
  deposit: "deposit.completed",
  transfer: "transfer.completed",
}

type BridgeReplayEventEnvelope = {
  event_id: string
  event_type: string
  event_object: unknown
  event_created_at: string
}

const toRouteKey = (eventType: string): string | null => {
  if (eventType.startsWith("kyc")) return "kyc"
  if (eventType.startsWith("deposit")) return "deposit"
  if (eventType.startsWith("transfer")) return "transfer"
  return null
}

const extractTransferId = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") return undefined
  const candidate = payload as Record<string, unknown>
  const fromTransferId = candidate.transfer_id
  const fromId = candidate.id
  const orchestration = candidate.orchestration as Record<string, unknown> | undefined
  const fromOrchestrationTransferId = orchestration?.transfer_id

  if (typeof fromTransferId === "string") return fromTransferId
  if (typeof fromId === "string") return fromId
  if (typeof fromOrchestrationTransferId === "string") return fromOrchestrationTransferId
  return undefined
}

const replayEvent = async (
  event: BridgeReplayEventEnvelope,
): Promise<{ status: number; body: unknown }> => {
  const routeKey = toRouteKey(event.event_type)

  if (!routeKey) {
    baseLogger.warn(
      { eventType: event.event_type },
      "Skipping unsupported event type for replay",
    )
    return { status: 0, body: { skipped: true, reason: "unsupported event type" } }
  }

  const response = await fetch(`${WEBHOOK_URL}/internal/replay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${REPLAY_SECRET}`,
    },
    body: JSON.stringify({
      event_type: event.event_type,
      event_object: event.event_object,
      event_created_at: event.event_created_at,
      operator: args.operator,
      time_window_start: args.start,
      time_window_end: args.end,
      dry_run: args["dry-run"],
    }),
  })

  const body = await response.json().catch(() => null)

  return { status: response.status, body }
}

const main = async () => {
  let fetched = 0,
    success = 0,
    failed = 0,
    skipped = 0
  baseLogger.info(
    {
      start: args.start,
      end: args.end,
      eventType: args["event-type"],
      dryRun: args["dry-run"],
      operator: args.operator,
    },
    "Starting Bridge webhook replay",
  )

  const bridgeFilter = args["event-type"]
    ? EVENT_TYPE_FILTER[args["event-type"] as string]
    : undefined

  for await (const event of listAllEvents({
    start_date: args.start,
    end_date: args.end,
    event_type: bridgeFilter,
  })) {
    const replayEventObject: BridgeReplayEventEnvelope = {
      event_id: event.id,
      event_type: event.event_type,
      event_created_at: event.created_at,
      event_object: event.payload,
    }

    if (args["transfer-id"]) {
      const transferId = extractTransferId(replayEventObject.event_object)
      if (transferId !== args["transfer-id"]) {
        skipped++
        continue
      }
    }

    fetched++

    const { status, body } = await replayEvent(replayEventObject)

    if (status >= 200 && status < 300) {
      success++
      baseLogger.info(
        { eventId: event.id, eventType: event.event_type, status, response: body },
        "Successfully replayed event",
      )
    } else if (status === 0) {
      skipped++
      baseLogger.info(
        { eventId: event.id, eventType: event.event_type, status, response: body },
        "Skipped event",
      )
    } else {
      failed++
      baseLogger.error(
        { eventId: event.id, eventType: event.event_type, status, response: body },
        "Failed to replay event",
      )
    }

    await new Promise((resolve) => setTimeout(resolve, 100)) // small delay to avoid overwhelming the webhook server
  }

  baseLogger.info(
    { fetched, success, failed, skipped },
    "Completed Bridge webhook replay",
  )
}

setupMongoConnection()
  .then(async (mongoose) => {
    await main()
    await mongoose?.connection.close()
    process.exit(0)
  })
  .catch((error) => {
    baseLogger.error({ error }, "Error in Bridge webhook replay")
    process.exit(1)
  })
