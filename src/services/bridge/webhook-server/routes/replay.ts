import crypto from "crypto"

import { Request, Response } from "express"

import { BridgeConfig } from "@config"

import { baseLogger } from "@services/logger"

import { createBridgeReplayLog } from "@services/mongoose/bridge-replay-log"

import { depositHandler } from "./deposit"
import { kycHandler } from "./kyc"
import { transferHandler } from "./transfer"
type RouteKey = "kyc" | "deposit" | "transfer"

const HANDLERS: Record<RouteKey, (req: Request, res: Response) => Promise<Response>> = {
  kyc: kycHandler,
  deposit: depositHandler,
  transfer: transferHandler,
}

const DEPOSIT_EVENT_TYPES = new Set([
  "funds_scheduled",
  "funds_received",
  "payment_submitted",
  "payment_processed",
  "in_review",
  "microdeposit",
  "refund_in_flight",
  "refunded",
  "refund_failed",
])

const toRouteKey = (bridgeEventType: string): RouteKey | null => {
  if (bridgeEventType.startsWith("kyc")) return "kyc"
  if (bridgeEventType.startsWith("transfer")) return "transfer"
  if (DEPOSIT_EVENT_TYPES.has(bridgeEventType)) return "deposit"
  return null
}

const resolveReplayEventType = ({
  eventType,
  eventObjectStatus,
}: {
  eventType: string
  eventObjectStatus?: string
}): string => {
  const routeFromEventType = toRouteKey(eventType)
  if (routeFromEventType) return eventType

  if (eventObjectStatus && DEPOSIT_EVENT_TYPES.has(eventObjectStatus)) {
    return eventObjectStatus
  }

  if (eventObjectStatus === "approved" || eventObjectStatus === "rejected") {
    return `kyc.${eventObjectStatus}`
  }

  if (eventObjectStatus === "completed" || eventObjectStatus === "failed") {
    return `transfer.${eventObjectStatus}`
  }

  return eventType
}

const toHandlerBody = ({
  routeKey,
  eventId,
  eventType,
  eventObject,
}: {
  routeKey: RouteKey
  eventId: string
  eventType: string
  eventObject: Record<string, unknown>
}): Record<string, unknown> => {
  if (routeKey === "transfer") {
    return {
      event: eventType,
      data: {
        transfer_id: eventObject.transfer_id ?? eventObject.id,
        state: eventObject.state,
        amount: eventObject.amount,
        currency: eventObject.currency,
      },
    }
  }

  return {
    event_id: eventId,
    event_object: eventObject,
  }
}

export const replayAuthMiddleware = (req: Request, res: Response, next: () => void) => {
  const secret =
    BridgeConfig.webhook.replaySecret ?? process.env.BRIDGE_WEBHOOK_REPLAY_SECRET
  if (!secret) {
    baseLogger.warn("Replay secret not configured, rejecting replay request")
    return res.status(503).json({ error: "Replay secret not configured" })
  }

  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "")

  const valid =
    token.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))

  if (!valid) {
    baseLogger.warn("Invalid replay token provided")
    return res.status(401).json({ error: "Unauthorized" })
  }

  next()
}

export const replayHandler = async (req: Request, res: Response) => {
  const {
    event_id,
    event_type,
    event_object_status,
    event_object,
    event_created_at,
    operator,
    time_window_start,
    time_window_end,
    dry_run = false,
  } = req.body

  if (!event_type || !event_object || !event_created_at) {
    return res.status(400).json({
      error:
        "Missing required fields: event_type, event_object, event_created_at, operator, time_window_start, time_window_end",
    })
  }

  if (typeof event_object !== "object" || event_object === null) {
    return res.status(400).json({ error: "event_object must be an object" })
  }

  const normalizedEventType = resolveReplayEventType({
    eventType: event_type,
    eventObjectStatus:
      typeof event_object_status === "string" ? event_object_status : undefined,
  })

  const routeKey = toRouteKey(normalizedEventType)

  if (!routeKey) {
    return res.status(400).json({ error: "Unsupported event_type for replay" })
  }

  const eventObjectTyped = event_object as Record<string, unknown>
  const eventId: string =
    typeof event_id === "string"
      ? event_id
      : typeof eventObjectTyped.event_id === "string"
        ? eventObjectTyped.event_id
        : typeof eventObjectTyped.id === "string"
          ? eventObjectTyped.id
          : crypto.randomUUID()

  const logBase = {
    eventId,
    eventType: routeKey,
    eventPayload: event_object,
    bridgeEventCreatedAt: new Date(event_created_at),
    replayedAt: new Date(),
    operator,
    timeWindowStart: new Date(time_window_start),
    timeWindowEnd: new Date(time_window_end),
    dryRun: dry_run,
  }

  if (dry_run) {
    const dryRunLog = await createBridgeReplayLog({
      ...logBase,
      httpStatus: 0,
      httpResponse: { dry_run: true },
    })
    if (dryRunLog instanceof Error) {
      baseLogger.error(
        { error: dryRunLog },
        "Failed to log bridge dry-run replay attempt",
      )
      return res.status(500).json({ error: "Failed to log dry-run replay attempt" })
    }
    return res.status(200).json({
      message: "Dry run successful, event not replayed",
      log: logBase,
      event_id: eventId,
    })
  }

  let handlerStatus = 500
  let handlerBody: Record<string, unknown> = {}

  const fakeReq = {
    body: toHandlerBody({
      routeKey,
      eventId,
      eventType: normalizedEventType,
      eventObject: eventObjectTyped,
    }),
    headers: {},
  } as unknown as Request
  const fakeRes = {
    status: function (code: number) {
      handlerStatus = code
      return this
    },
    json: function (body: unknown) {
      handlerBody = body as Record<string, unknown>
      return this
    },
  } as unknown as Response

  await HANDLERS[routeKey](fakeReq, fakeRes)

  const logResult = await createBridgeReplayLog({
    ...logBase,
    httpStatus: handlerStatus,
    httpResponse: handlerBody,
  })

  if (logResult instanceof Error) {
    baseLogger.error({ error: logResult }, "Failed to log bridge replay attempt")
    return res
      .status(500)
      .json({ error: "Failed to log replay attempt", details: logResult.message })
  }
  return res.status(handlerStatus).json({
    status: "replayed",
    event_id: eventId,
    handler_status: handlerStatus,
    handler_response: handlerBody,
    log_id: logResult.id,
  })
}
