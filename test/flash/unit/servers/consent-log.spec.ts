import { Request, Response } from "express"

import { ConsentLogIpRateLimiterExceededError } from "@domain/rate-limit/errors"
import { ConsentLogRepository } from "@services/mongoose/models/consent-log"
import { consumeLimiter } from "@services/rate-limit"
import consentLogRouter from "@servers/consent-log"
import { hashToken } from "@utils"

// Deterministic IP source: always resolve from headers, the way the k8s
// ingress path does in production.
jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  UNSECURE_IP_FROM_REQUEST_OBJECT: false,
}))

jest.mock("@services/rate-limit", () => ({ consumeLimiter: jest.fn() }))

jest.mock("@services/mongoose/models/consent-log", () => ({
  ConsentLogRepository: { create: jest.fn() },
}))

const mockedConsumeLimiter = consumeLimiter as jest.MockedFunction<typeof consumeLimiter>
const mockedCreate = ConsentLogRepository.create as jest.MockedFunction<
  typeof ConsentLogRepository.create
>

type Layer = {
  route?: { path: string; stack: { handle: (...args: unknown[]) => unknown }[] }
  handle: (...args: unknown[]) => unknown
}

const routerStack = (consentLogRouter as unknown as { stack: Layer[] }).stack

const postHandler = (() => {
  const layer = routerStack.find((l) => l.route?.path === "/log")
  if (!layer?.route) throw new Error("no route registered at /log")
  return layer.route.stack[0].handle as unknown as (
    req: Request,
    res: Response,
  ) => Promise<unknown>
})()

// Express identifies error handlers by arity 4.
const errorHandler = (() => {
  const layer = routerStack.find((l) => !l.route && l.handle.length === 4)
  if (!layer) throw new Error("no error handler registered on consent router")
  return layer.handle as unknown as (
    err: unknown,
    req: Request,
    res: Response,
    next: () => void,
  ) => unknown
})()

const corsMiddleware = (() => {
  const layer = routerStack.find((l) => !l.route && l.handle.name === "corsMiddleware")
  if (!layer) throw new Error("no cors middleware registered on consent router")
  return layer.handle as unknown as (
    req: unknown,
    res: unknown,
    next: () => void,
  ) => unknown
})()

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn(), send: jest.fn() }
  res.status.mockReturnValue(res)
  return res as unknown as Response & {
    status: jest.Mock
    json: jest.Mock
    send: jest.Mock
  }
}

const validBody = () => ({
  version: "2026-08-01",
  page: "https://getflash.io/invite",
  userAgent: "jest",
  timestamp: "2026-08-30T12:00:00Z",
  token: "a".repeat(40),
  consents: {
    transactional: { optedIn: true, purpose: "receipts", frequency: "per-event" },
    marketing: { optedIn: false },
  },
})

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    headers: { "x-real-ip": "203.0.113.7" },
    body: validBody(),
    ...overrides,
  }) as unknown as Request

describe("POST /consent/log", () => {
  beforeEach(() => {
    mockedConsumeLimiter.mockReset()
    mockedCreate.mockReset()
  })

  it("returns 204 on success and stores only the token hash, never the raw token", async () => {
    mockedConsumeLimiter.mockResolvedValue(1 as never)
    mockedCreate.mockResolvedValue(undefined as never)

    const body = validBody()
    const res = makeRes()
    await postHandler(makeReq({ body }), res)

    expect(res.status).toHaveBeenCalledWith(204)
    expect(mockedCreate).toHaveBeenCalledTimes(1)

    const stored = mockedCreate.mock.calls[0][0] as Record<string, unknown>
    expect(stored.inviteTokenHash).toBe(hashToken(body.token))
    expect(stored).not.toHaveProperty("token")
    expect(JSON.stringify(stored)).not.toContain(body.token)
  })

  it("rate limits per IP and returns 429 when exceeded", async () => {
    mockedConsumeLimiter.mockResolvedValue(
      new ConsentLogIpRateLimiterExceededError() as never,
    )

    const res = makeRes()
    await postHandler(makeReq(), res)

    expect(mockedConsumeLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ keyToConsume: "203.0.113.7" }),
    )
    expect(res.status).toHaveBeenCalledWith(429)
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it("fails closed with 503 when the rate-limit store is unavailable", async () => {
    mockedConsumeLimiter.mockResolvedValue(new Error("redis down") as never)

    const res = makeRes()
    await postHandler(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it("falls back to x-forwarded-for when x-real-ip is absent", async () => {
    mockedConsumeLimiter.mockResolvedValue(1 as never)
    mockedCreate.mockResolvedValue(undefined as never)

    const res = makeRes()
    await postHandler(makeReq({ headers: { "x-forwarded-for": "198.51.100.9" } }), res)

    expect(mockedConsumeLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ keyToConsume: "198.51.100.9" }),
    )
    expect(res.status).toHaveBeenCalledWith(204)
  })

  it("returns 503 (not a shared global bucket) when no client IP is resolvable", async () => {
    const res = makeRes()
    await postHandler(makeReq({ headers: {} }), res)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(mockedConsumeLimiter).not.toHaveBeenCalled()
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it("maps validation failures to 400 without touching the store", async () => {
    mockedConsumeLimiter.mockResolvedValue(1 as never)

    const res = makeRes()
    await postHandler(makeReq({ body: { version: "v1" } }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it("returns 500 with a generic body when persistence fails", async () => {
    mockedConsumeLimiter.mockResolvedValue(1 as never)
    mockedCreate.mockRejectedValue(new Error("mongo down: secret-host:27017"))

    const res = makeRes()
    await postHandler(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: "could not record consent" })
    const sent = JSON.stringify(res.json.mock.calls)
    expect(sent).not.toContain("secret-host")
  })
})

describe("consent router error handler", () => {
  it("answers malformed JSON with a 400 JSON body, not Express's HTML page", () => {
    const err = Object.assign(new SyntaxError("Unexpected token"), {
      type: "entity.parse.failed",
      status: 400,
    })
    const res = makeRes()
    errorHandler(err, {} as Request, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: "invalid body" })
  })

  it("answers oversized bodies with 413", () => {
    const err = Object.assign(new Error("request entity too large"), {
      type: "entity.too.large",
      status: 413,
    })
    const res = makeRes()
    errorHandler(err, {} as Request, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(413)
    expect(res.json).toHaveBeenCalledWith({ error: "body too large" })
  })

  it("answers anything else with a generic 500, leaking no internals", () => {
    const err = new Error("boom with /etc/secrets path")
    const res = makeRes()
    errorHandler(err, {} as Request, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(500)
    const sent = JSON.stringify(res.json.mock.calls)
    expect(sent).not.toContain("/etc/secrets")
  })
})

describe("consent router CORS", () => {
  it("answers the getflash.io preflight with Access-Control-Allow-Origin", () => {
    const headers: Record<string, string> = {}
    const req = {
      method: "OPTIONS",
      headers: {
        "origin": "https://getflash.io",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    }
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string | string[]) => {
        headers[name.toLowerCase()] = String(value)
      },
      getHeader: (name: string) => headers[name.toLowerCase()],
      end: jest.fn(),
    }
    const next = jest.fn()

    corsMiddleware(req, res, next)

    expect(headers["access-control-allow-origin"]).toBe("https://getflash.io")
    expect(res.end).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})
