import { Request, Response } from "express"
import { depositHandler } from "./deposit"
import { kycHandler } from "./kyc"
import { transferHandler } from "./transfer"
import { BridgeConfig } from "@config"
import { baseLogger } from "@services/logger"
import crypto from "crypto"
import { createBridgeReplayLog } from "@services/mongoose/bridge-replay-log"
type RouteKey = "kyc" | "deposit" | "transfer"

const HANDLERS: Record<RouteKey, (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>> = {
    kyc: kycHandler,
    deposit: depositHandler,
    transfer: transferHandler
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


export const replayAuthMiddleware = (req: Request, res: Response, next: () => void) => {

    const secret = BridgeConfig.webhook.replaySecret ?? process.env.BRIDGE_WEBHOOK_REPLAY_SECRET
    if (!secret) {
        baseLogger.warn("Replay secret not configured, rejecting replay request")
        return res.status(503).json({ error: "Replay secret not configured" })
    }

    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "")

    const valid = token.length === secret.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));

    if (!valid) {
        baseLogger.warn("Invalid replay token provided")
        return res.status(401).json({ error: "Unauthorized" })
    }

    next()
}

export const replayHandler = async (req: Request, res: Response) => {

    const { event_type, event_object, event_created_at, operator, time_window_start, time_window_end, dry_run = false } = req.body

    if (!event_type || !event_object || !event_created_at) {
        return res.status(400).json({ error: "Missing required fields: event_type, event_object, event_created_at, operator, time_window_start, time_window_end" })
    }

    const routeKey = toRouteKey(event_type)

    if (!routeKey) {
        return res.status(400).json({ error: "Unsupported event_type for replay" })
    }

    const eventId: string = (event_object as any).id ?? (event_object as any).event_id ?? crypto.randomUUID()

    const logBase = {
        eventId,
        eventType: routeKey,
        eventPayload: event_object,
        bridgeEventCreatedAt: new Date(event_created_at),
        replayedAt: new Date(),
        operator,
        timeWindowStart: new Date(time_window_start),
        timeWindowEnd: new Date(time_window_end),
        dryRun: dry_run
    }

    if (dry_run) {
        const dryRunLog = await createBridgeReplayLog({ ...logBase, httpStatus: 0, httpResponse: { dry_run: true } })
        if (dryRunLog instanceof Error) {
            baseLogger.error({ error: dryRunLog }, "Failed to log bridge dry-run replay attempt")
            return res.status(500).json({ error: "Failed to log dry-run replay attempt" })
        }
        return res.status(200).json({ message: "Dry run successful, event not replayed", log: logBase, event_id: eventId })
    }


    let handlerStatus = 500
    let handlerBody: Record<string, unknown> = {}

    const fakeReq = { body: event_object, headers: {} } as unknown as Request
    const fakeRes = {
        status: function (code: number) {
            handlerStatus = code;
            return this
        },
        json: function (body: unknown) {
            handlerBody = body as Record<string, unknown>;
            return this
        }
    } as unknown as Response

    await HANDLERS[routeKey](fakeReq, fakeRes)

    const logResult = await createBridgeReplayLog({ ...logBase, httpStatus: handlerStatus, httpResponse: handlerBody })

    if (logResult instanceof Error) {
        baseLogger.error({ error: logResult }, "Failed to log bridge replay attempt")
        return res.status(500).json({ error: "Failed to log replay attempt", details: logResult.message })
    }
    return res.status(handlerStatus).json({
        status: "replayed",
        event_id: eventId,
        handler_status: handlerStatus,
        handler_response: handlerBody,
        log_id: logResult.id
    })
}