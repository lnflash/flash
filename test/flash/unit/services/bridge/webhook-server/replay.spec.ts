import crypto from "crypto"

// AC1: Orphan event surfaces in ops tooling with triage context
// AC2: Replay CLI re-runs a stuck handler against a chosen transfer-id

jest.mock("@config", () => ({
  BridgeConfig: {
    webhook: { replaySecret: "super-secret-replay-token-xyz" },
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose/bridge-replay-log", () => ({
  createBridgeReplayLog: jest.fn(),
}))

jest.mock("@services/bridge/webhook-server/routes/deposit", () => ({
  depositHandler: jest.fn(),
}))
jest.mock("@services/bridge/webhook-server/routes/kyc", () => ({
  kycHandler: jest.fn(),
}))
jest.mock("@services/bridge/webhook-server/routes/transfer", () => ({
  transferHandler: jest.fn(),
}))

import { Request, Response } from "express"
import { replayAuthMiddleware, replayHandler } from "@services/bridge/webhook-server/routes/replay"
import * as ReplayLog from "@services/mongoose/bridge-replay-log"
import { depositHandler } from "@services/bridge/webhook-server/routes/deposit"
import { kycHandler } from "@services/bridge/webhook-server/routes/kyc"
import { transferHandler } from "@services/bridge/webhook-server/routes/transfer"

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  ({ body, headers } as unknown as Request)

const BASE_BODY = {
  event_type: "funds_received",
  event_object: { id: "evt-001", transfer_id: "xfer-001" },
  event_created_at: "2026-05-01T12:00:00Z",
  operator: "ops@example.com",
  time_window_start: "2026-05-01T00:00:00Z",
  time_window_end: "2026-05-01T23:59:59Z",
}

// ── replayAuthMiddleware ──────────────────────────────────────────────────────

describe("replayAuthMiddleware", () => {
  beforeEach(() => jest.clearAllMocks())

  it("returns 503 when replaySecret is not configured", () => {
    const { BridgeConfig } = jest.requireMock("@config")
    const saved = BridgeConfig.webhook.replaySecret
    BridgeConfig.webhook.replaySecret = undefined

    const res = makeRes()
    const next = jest.fn()
    replayAuthMiddleware(makeReq({}, {}), res, next)

    expect((res.status as jest.Mock)).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()

    BridgeConfig.webhook.replaySecret = saved
  })

  it("returns 401 for a wrong token", () => {
    const res = makeRes()
    const next = jest.fn()
    replayAuthMiddleware(
      makeReq({}, { authorization: "Bearer wrong-token" }),
      res,
      next,
    )

    expect((res.status as jest.Mock)).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("returns 401 when Authorization header is absent", () => {
    const res = makeRes()
    const next = jest.fn()
    replayAuthMiddleware(makeReq({}, {}), res, next)

    expect((res.status as jest.Mock)).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("calls next() for the correct Bearer token", () => {
    const res = makeRes()
    const next = jest.fn()
    replayAuthMiddleware(
      makeReq({}, { authorization: "Bearer super-secret-replay-token-xyz" }),
      res,
      next,
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect((res.status as jest.Mock)).not.toHaveBeenCalled()
  })

  it("uses timing-safe comparison (different-length token is rejected)", () => {
    const res = makeRes()
    const next = jest.fn()
    // A prefix of the real secret — same content up to length, but different length
    replayAuthMiddleware(
      makeReq({}, { authorization: "Bearer super-secret-replay-token-xy" }),
      res,
      next,
    )

    expect((res.status as jest.Mock)).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})

// ── replayHandler ─────────────────────────────────────────────────────────────

describe("replayHandler", () => {
  beforeEach(() => jest.clearAllMocks())

  describe("input validation", () => {
    it("returns 400 when event_type is missing", async () => {
      const res = makeRes()
      const { event_type: _et, ...body } = BASE_BODY
      await replayHandler(makeReq(body), res)
      expect((res.status as jest.Mock)).toHaveBeenCalledWith(400)
    })

    it("returns 400 when event_object is missing", async () => {
      const res = makeRes()
      const { event_object: _eo, ...body } = BASE_BODY
      await replayHandler(makeReq(body), res)
      expect((res.status as jest.Mock)).toHaveBeenCalledWith(400)
    })

    it("returns 400 when event_created_at is missing", async () => {
      const res = makeRes()
      const { event_created_at: _ec, ...body } = BASE_BODY
      await replayHandler(makeReq(body), res)
      expect((res.status as jest.Mock)).toHaveBeenCalledWith(400)
    })

    it("returns 400 for an unrecognised event_type", async () => {
      const res = makeRes()
      await replayHandler(makeReq({ ...BASE_BODY, event_type: "unknown_event" }), res)
      expect((res.status as jest.Mock)).toHaveBeenCalledWith(400)
    })
  })

  describe("event_type → handler routing", () => {
    const cases: Array<[string, jest.Mock]> = [
      ["funds_received",  depositHandler as jest.Mock],
      ["funds_scheduled", depositHandler as jest.Mock],
      ["payment_processed", depositHandler as jest.Mock],
      ["kyc.approved",   kycHandler as jest.Mock],
      ["kyc.rejected",   kycHandler as jest.Mock],
      ["transfer.completed", transferHandler as jest.Mock],
      ["transfer.failed",    transferHandler as jest.Mock],
    ]

    beforeEach(() => {
      ;(ReplayLog.createBridgeReplayLog as jest.Mock).mockResolvedValue({ id: "log-001" })
    })

    test.each(cases)("%s is routed to the correct handler", async (eventType, handler) => {
      handler.mockImplementation((_req: Request, res: Response) => {
        ;(res.status as jest.Mock)(200)
        ;(res.json as jest.Mock)({ status: "success" })
        return Promise.resolve(res)
      })

      const res = makeRes()
      await replayHandler(makeReq({ ...BASE_BODY, event_type: eventType }), res)

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe("dry_run mode", () => {
    it("returns 200 without calling any handler", async () => {
      ;(ReplayLog.createBridgeReplayLog as jest.Mock).mockResolvedValue({ id: "log-dry-001" })

      const res = makeRes()
      await replayHandler(makeReq({ ...BASE_BODY, dry_run: true }), res)

      expect(depositHandler).not.toHaveBeenCalled()
      expect(kycHandler).not.toHaveBeenCalled()
      expect(transferHandler).not.toHaveBeenCalled()
      expect((res.status as jest.Mock)).toHaveBeenCalledWith(200)
    })

    it("persists a dry-run log entry with httpStatus 0", async () => {
      ;(ReplayLog.createBridgeReplayLog as jest.Mock).mockResolvedValue({ id: "log-dry-002" })

      const res = makeRes()
      await replayHandler(makeReq({ ...BASE_BODY, dry_run: true }), res)

      expect(ReplayLog.createBridgeReplayLog).toHaveBeenCalledWith(
        expect.objectContaining({ httpStatus: 0, dryRun: true }),
      )
    })

    it("returns 500 when dry-run log creation fails", async () => {
      ;(ReplayLog.createBridgeReplayLog as jest.Mock).mockResolvedValue(new Error("db error"))

      const res = makeRes()
      await replayHandler(makeReq({ ...BASE_BODY, dry_run: true }), res)

      expect((res.status as jest.Mock)).toHaveBeenCalledWith(500)
    })
  })

  describe("live replay", () => {
    beforeEach(() => {
      ;(depositHandler as jest.Mock).mockImplementation((_req: Request, res: Response) => {
        ;(res.status as jest.Mock)(200)
        ;(res.json as jest.Mock)({ status: "success" })
        return Promise.resolve(res)
      })
    })

    it("returns the handler's status code and response body", async () => {
      ;(ReplayLog.createBridgeReplayLog as jest.Mock).mockResolvedValue({ id: "log-live-001" })

      const res = makeRes()
      await replayHandler(makeReq(BASE_BODY), res)

      expect((res.status as jest.Mock)).toHaveBeenCalledWith(200)
      const jsonArg = (res.json as jest.Mock).mock.calls[0][0]
      expect(jsonArg).toMatchObject({ status: "replayed", handler_status: 200 })
    })

    it("persists a replay log with triage context (operator + time window)", async () => {
      ;(ReplayLog.createBridgeReplayLog as jest.Mock).mockResolvedValue({ id: "log-live-002" })

      const res = makeRes()
      await replayHandler(makeReq(BASE_BODY), res)

      expect(ReplayLog.createBridgeReplayLog).toHaveBeenCalledWith(
        expect.objectContaining({
          operator: "ops@example.com",
          timeWindowStart: new Date("2026-05-01T00:00:00Z"),
          timeWindowEnd: new Date("2026-05-01T23:59:59Z"),
          eventId: "evt-001",
          httpStatus: 200,
          dryRun: false,
        }),
      )
    })

    it("includes log_id in the response so ops can trace the replay", async () => {
      ;(ReplayLog.createBridgeReplayLog as jest.Mock).mockResolvedValue({ id: "log-trace-007" })

      const res = makeRes()
      await replayHandler(makeReq(BASE_BODY), res)

      const jsonArg = (res.json as jest.Mock).mock.calls[0][0]
      expect(jsonArg.log_id).toBe("log-trace-007")
    })

    it("returns 500 when log creation fails after a successful handler run", async () => {
      ;(ReplayLog.createBridgeReplayLog as jest.Mock).mockResolvedValue(new Error("mongo down"))

      const res = makeRes()
      await replayHandler(makeReq(BASE_BODY), res)

      expect((res.status as jest.Mock)).toHaveBeenCalledWith(500)
    })

    it("propagates a handler 4xx back to the caller", async () => {
      ;(depositHandler as jest.Mock).mockImplementation((_req: Request, res: Response) => {
        ;(res.status as jest.Mock)(422)
        ;(res.json as jest.Mock)({ error: "Unprocessable" })
        return Promise.resolve(res)
      })
      ;(ReplayLog.createBridgeReplayLog as jest.Mock).mockResolvedValue({ id: "log-4xx" })

      const res = makeRes()
      await replayHandler(makeReq(BASE_BODY), res)

      expect((res.status as jest.Mock)).toHaveBeenCalledWith(422)
    })
  })
})
