import crypto from "crypto"

import { Request, Response } from "express"
import ipaddr from "ipaddr.js"

import { BridgeConfig } from "@config"

import { baseLogger } from "@services/logger"

import { createBridgeReplay } from "@services/mongoose/bridge-replay-log"

import {
  isOutboundBridgeWithdrawal,
  transferReplayEventTypeForStatus,
} from "../transfer-direction"

import { depositHandler } from "./deposit"
import { externalAccountHandler } from "./external-account"
import { kycHandler } from "./kyc"
import { transferHandler } from "./transfer"
type RouteKey = "kyc" | "deposit" | "transfer" | "external_account"
type ParsedRange = [ipaddr.IPv4 | ipaddr.IPv6, number]

const HANDLERS: Record<RouteKey, (req: Request, res: Response) => Promise<Response>> = {
  kyc: kycHandler,
  deposit: depositHandler,
  transfer: transferHandler,
  external_account: externalAccountHandler,
}

const WEAK_REPLAY_SECRETS = new Set(["also-not-so-secret", "change-me", "<replace>"])
const REPLAY_ALLOWED_IPS_ENV = "BRIDGE_WEBHOOK_REPLAY_ALLOWED_IPS"

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
  if (bridgeEventType.startsWith("external_account")) return "external_account"
  if (DEPOSIT_EVENT_TYPES.has(bridgeEventType)) return "deposit"
  return null
}

const resolveReplayEventType = ({
  eventType,
  eventObjectStatus,
  eventObject,
}: {
  eventType: string
  eventObjectStatus?: string
  eventObject?: Record<string, unknown>
}): string => {
  const routeFromEventType = toRouteKey(eventType)
  if (routeFromEventType) return eventType

  if (eventObjectStatus && DEPOSIT_EVENT_TYPES.has(eventObjectStatus)) {
    if (isOutboundBridgeWithdrawal(eventObject)) {
      const transferEvent = transferReplayEventTypeForStatus(eventObjectStatus)
      if (transferEvent) return transferEvent
    }
    return eventObjectStatus
  }

  const KYC_BRIDGE_STATUSES = new Set([
    "not_started",
    "incomplete",
    "awaiting_questionnaire",
    "awaiting_ubo",
    "under_review",
    "approved",
    "rejected",
    "paused",
    "offboarded",
  ])
  if (eventObjectStatus && KYC_BRIDGE_STATUSES.has(eventObjectStatus)) {
    return `kyc.${eventObjectStatus}`
  }

  if (eventObjectStatus === "completed" || eventObjectStatus === "failed") {
    return `transfer.${eventObjectStatus}`
  }

  return eventType
}

const parseReplayAllowlistEntry = (entry: string): ParsedRange | null => {
  const trimmed = entry.trim()
  if (!trimmed) return null

  try {
    if (trimmed.includes("/")) return ipaddr.parseCIDR(trimmed)
    const addr = ipaddr.parse(trimmed)
    return [addr, addr.kind() === "ipv6" ? 128 : 32]
  } catch {
    baseLogger.error({ entry }, "Ignoring invalid Bridge replay IP allowlist entry")
    return null
  }
}

const parseReplayAllowlist = (value: string | undefined): ParsedRange[] =>
  (value ?? "")
    .split(",")
    .map(parseReplayAllowlistEntry)
    .filter((range): range is ParsedRange => range !== null)

const isLoopbackIp = (clientIp: string | null | undefined): boolean => {
  if (!clientIp || !ipaddr.isValid(clientIp)) return false
  return ipaddr.process(clientIp).range() === "loopback"
}

export const isReplayIpAllowed = (
  clientIp: string | null | undefined,
  allowlistEnv: string | undefined = process.env[REPLAY_ALLOWED_IPS_ENV],
): boolean => {
  if (!clientIp || !ipaddr.isValid(clientIp)) return false

  const addr = ipaddr.process(clientIp)
  const ranges = parseReplayAllowlist(allowlistEnv)

  return ranges.some(([rangeAddr, prefix]) => {
    if (addr.kind() === "ipv4" && rangeAddr.kind() === "ipv4") {
      return (addr as ipaddr.IPv4).match(rangeAddr as ipaddr.IPv4, prefix)
    }
    if (addr.kind() === "ipv6" && rangeAddr.kind() === "ipv6") {
      return (addr as ipaddr.IPv6).match(rangeAddr as ipaddr.IPv6, prefix)
    }
    return false
  })
}

export const replayIngressMiddleware = (
  req: Request,
  res: Response,
  next: () => void,
) => {
  // Loopback trust must come from the socket address, never from a header any
  // external caller can set to "127.0.0.1" and walk through this gate.
  if (isLoopbackIp(req.socket?.remoteAddress)) return next()

  // req.ip, not request-ip: with `trust proxy` set on the server, Express
  // resolves the proxy-appended (rightmost untrusted) X-Forwarded-For entry,
  // so operators behind the ingress match on their real IP while forged XFF
  // entries stay untrusted. request-ip prefers the LEFTMOST entry, which a
  // caller could forge to an allowlisted IP.
  const clientIp = req.ip ?? req.socket?.remoteAddress

  if (!isReplayIpAllowed(clientIp)) {
    baseLogger.warn({ clientIp, path: req.path }, "Rejected Bridge replay request")
    return res.status(403).json({ error: "Forbidden" })
  }

  next()
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
        reason: eventObject.reason,
        return_reason: eventObject.return_reason,
      },
    }
  }

  return {
    event_id: eventId,
    event_object: eventObject,
  }
}

export const replayAuthMiddleware = (req: Request, res: Response, next: () => void) => {
  const secret = (
    process.env.BRIDGE_WEBHOOK_REPLAY_SECRET ||
    BridgeConfig.webhook.replaySecret ||
    ""
  ).trim()
  if (!secret) {
    baseLogger.warn("Replay secret not configured, rejecting replay request")
    return res.status(503).json({ error: "Replay secret not configured" })
  }
  if (WEAK_REPLAY_SECRETS.has(secret)) {
    baseLogger.warn("Weak replay secret configured, rejecting replay request")
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

  if (
    !event_type ||
    !event_object ||
    !event_created_at ||
    !operator ||
    !time_window_start ||
    !time_window_end
  ) {
    return res.status(400).json({
      error:
        "Missing required fields: event_type, event_object, event_created_at, operator, time_window_start, time_window_end",
    })
  }

  if (typeof operator !== "string" || operator.trim() === "") {
    return res.status(400).json({ error: "operator must be a non-empty string" })
  }

  if (typeof event_object !== "object" || event_object === null) {
    return res.status(400).json({ error: "event_object must be an object" })
  }

  const eventObjectTyped = event_object as Record<string, unknown>
  const bridgeEventCreatedAt = new Date(event_created_at)
  const timeWindowStart = new Date(time_window_start)
  const timeWindowEnd = new Date(time_window_end)

  if (
    Number.isNaN(bridgeEventCreatedAt.getTime()) ||
    Number.isNaN(timeWindowStart.getTime()) ||
    Number.isNaN(timeWindowEnd.getTime())
  ) {
    return res.status(400).json({
      error:
        "event_created_at, time_window_start, and time_window_end must be valid dates",
    })
  }

  const normalizedEventType = resolveReplayEventType({
    eventType: event_type,
    eventObjectStatus:
      typeof event_object_status === "string" ? event_object_status : undefined,
    eventObject: eventObjectTyped,
  })

  const routeKey = toRouteKey(normalizedEventType)

  if (!routeKey) {
    return res.status(400).json({ error: "Unsupported event_type for replay" })
  }
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
    bridgeEventCreatedAt,
    replayedAt: new Date(),
    operator,
    timeWindowStart,
    timeWindowEnd,
    dryRun: dry_run,
  }

  if (dry_run) {
    const dryRunLog = await createBridgeReplay({
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

  const logResult = await createBridgeReplay({
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
