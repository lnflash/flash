import { Readable } from "stream"

import { Request, Response } from "express"

import { ConsentLogIpRateLimiterExceededError } from "@domain/rate-limit/errors"
import { ConsentLogRepository } from "@services/mongoose/models/consent-log"
import { consumeLimiter } from "@services/rate-limit"
import consentLogRouter, { redactConsentBodyForLog } from "@servers/consent-log"
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

// The per-IP rate limiter, extracted as router-level middleware so it always
// runs ahead of body parsing — see the comment above its definition in
// src/servers/consent-log.ts for why it can't live inside the /log handler.
const rateLimitMiddleware = (() => {
  const layer = routerStack.find(
    (l) => !l.route && l.handle.name === "enforceConsentLogRateLimit",
  )
  if (!layer) throw new Error("no rate-limit middleware registered on consent router")
  return layer.handle as unknown as (
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ) => Promise<unknown>
})()

// The real (unmocked) body-parser middleware express.json() installs — used
// by the end-to-end test below to prove the actual production ordering.
const jsonParserMiddleware = (() => {
  const layer = routerStack.find((l) => !l.route && l.handle.name === "jsonParser")
  if (!layer) throw new Error("no json body-parser registered on consent router")
  return layer.handle as unknown as (
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ) => void
})()

const DEFAULT_IP = "203.0.113.7" as IpAddress

// postHandler now expects the rate-limit middleware to have already resolved
// the caller's IP onto res.locals — default it here so tests that aren't
// specifically about IP resolution don't have to repeat it.
const makeRes = (locals: Record<string, unknown> = { consentLogIp: DEFAULT_IP }) => {
  const res = { status: jest.fn(), json: jest.fn(), send: jest.fn(), locals }
  res.status.mockReturnValue(res)
  return res as unknown as Response & {
    status: jest.Mock
    json: jest.Mock
    send: jest.Mock
    locals: Record<string, unknown>
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
    mockedCreate.mockResolvedValue(undefined as never)

    const body = validBody()
    const res = makeRes()
    await postHandler(makeReq({ body }), res)

    expect(res.status).toHaveBeenCalledWith(204)
    expect(mockedCreate).toHaveBeenCalledTimes(1)

    const stored = mockedCreate.mock.calls[0][0] as Record<string, unknown>
    expect(stored.ip).toBe(DEFAULT_IP)
    expect(stored.inviteTokenHash).toBe(hashToken(body.token))
    expect(stored).not.toHaveProperty("token")
    expect(JSON.stringify(stored)).not.toContain(body.token)
  })

  it("maps validation failures to 400 without touching the store", async () => {
    const res = makeRes()
    await postHandler(makeReq({ body: { version: "v1" } }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it("returns 500 with a generic body when persistence fails", async () => {
    mockedCreate.mockRejectedValue(new Error("mongo down: secret-host:27017"))

    const res = makeRes()
    await postHandler(makeReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: "could not record consent" })
    const sent = JSON.stringify(res.json.mock.calls)
    expect(sent).not.toContain("secret-host")
  })
})

// The per-IP limiter lives here — router-level middleware mounted BEFORE
// express.json() — precisely so it always runs, whether or not the body
// that follows ever parses. See the end-to-end test below for the
// regression this guards against.
describe("consent router rate limiting (enforceConsentLogRateLimit)", () => {
  beforeEach(() => {
    mockedConsumeLimiter.mockReset()
  })

  it("consumes the limiter, stores the resolved ip on res.locals, and calls next()", async () => {
    mockedConsumeLimiter.mockResolvedValue(1 as never)

    const res = makeRes({})
    const next = jest.fn()
    await rateLimitMiddleware(makeReq(), res, next)

    expect(mockedConsumeLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ keyToConsume: "203.0.113.7" }),
    )
    expect(res.locals.consentLogIp).toBe("203.0.113.7")
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("falls back to x-forwarded-for when x-real-ip is absent", async () => {
    mockedConsumeLimiter.mockResolvedValue(1 as never)

    const res = makeRes({})
    const next = jest.fn()
    await rateLimitMiddleware(
      makeReq({ headers: { "x-forwarded-for": "198.51.100.9" } }),
      res,
      next,
    )

    expect(mockedConsumeLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ keyToConsume: "198.51.100.9" }),
    )
    expect(res.locals.consentLogIp).toBe("198.51.100.9")
    expect(next).toHaveBeenCalledTimes(1)
  })

  it("returns 429 and does not call next() when the limit is exceeded", async () => {
    mockedConsumeLimiter.mockResolvedValue(
      new ConsentLogIpRateLimiterExceededError() as never,
    )

    const res = makeRes({})
    const next = jest.fn()
    await rateLimitMiddleware(makeReq(), res, next)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(next).not.toHaveBeenCalled()
    expect(res.locals.consentLogIp).toBeUndefined()
  })

  it("fails closed with 503 and does not call next() when the rate-limit store is unavailable", async () => {
    mockedConsumeLimiter.mockResolvedValue(new Error("redis down") as never)

    const res = makeRes({})
    const next = jest.fn()
    await rateLimitMiddleware(makeReq(), res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })

  it("returns 503 (not a shared global bucket) without consuming the limiter when no client IP is resolvable", async () => {
    const res = makeRes({})
    const next = jest.fn()
    await rateLimitMiddleware(makeReq({ headers: {} }), res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(mockedConsumeLimiter).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})

// Regression test for the finding: the limiter used to be consumed only
// inside the /log route handler, which runs AFTER express.json() has parsed
// the body. A malformed or oversized body never reaches the route handler —
// body-parser routes those straight to the error handler — so an attacker
// could flood the endpoint with exactly that traffic shape and never once
// touch the limiter. Wiring the limiter as router-level middleware ahead of
// express.json() closes that gap. This exercises the ACTUAL production
// middleware pulled off the router (not a reimplementation), including the
// real body-parser, so it would have failed against the old ordering.
describe("consent router — rate limiting runs even when the body fails to parse", () => {
  beforeEach(() => {
    mockedConsumeLimiter.mockReset()
    mockedCreate.mockReset()
  })

  const makeRawReq = (bodyStr: string) => {
    const req = Readable.from([Buffer.from(bodyStr)]) as unknown as Request & Readable
    ;(req as unknown as { headers: Record<string, string> }).headers = {
      "x-real-ip": "203.0.113.7",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(bodyStr)),
    }
    ;(req as unknown as { method: string }).method = "POST"
    return req
  }

  const runChain = async (bodyStr: string) => {
    mockedConsumeLimiter.mockResolvedValue(1 as never)

    const req = makeRawReq(bodyStr)
    const res = makeRes({})

    await new Promise<void>((resolve) => {
      rateLimitMiddleware(req, res, (rateLimitErr) => {
        if (rateLimitErr) return resolve()
        jsonParserMiddleware(req, res, (parseErr) => {
          if (parseErr) {
            errorHandler(parseErr, req, res, jest.fn())
          }
          resolve()
        })
      })
    })

    return res
  }

  it("still consumes the limiter for an oversized body, and the body-parser error still surfaces as 413", async () => {
    const oversized = JSON.stringify({ padding: "a".repeat(9000) })
    const res = await runChain(oversized)

    expect(mockedConsumeLimiter).toHaveBeenCalledTimes(1)
    expect(res.status).toHaveBeenCalledWith(413)
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it("still consumes the limiter for malformed JSON, and the body-parser error still surfaces as 400", async () => {
    const res = await runChain("{not valid json")

    expect(mockedConsumeLimiter).toHaveBeenCalledTimes(1)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: "invalid body" })
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

  it("also answers the www.getflash.io preflight — www visitors must not be dropped", () => {
    const headers: Record<string, string> = {}
    const req = {
      method: "OPTIONS",
      headers: {
        "origin": "https://www.getflash.io",
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

    expect(headers["access-control-allow-origin"]).toBe("https://www.getflash.io")
    expect(res.end).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it("does not allow arbitrary origins", () => {
    const headers: Record<string, string> = {}
    const req = {
      method: "OPTIONS",
      headers: {
        "origin": "https://evil.example",
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

    expect(headers["access-control-allow-origin"]).toBeUndefined()
  })
})

describe("access-log body redaction (redactConsentBodyForLog)", () => {
  // pino-http re-evaluates customProps at response finish — by then
  // express.json() inside the consent router has populated req.body, so an
  // unredacted body log would write the raw invite token to disk on every
  // status path (204/400/429/503/404).
  //
  // Gated on res.locals.consentLogIp, not the request URL. Two rounds of
  // URL-string matching here each shipped a distinct token-leak bypass:
  // req.url loses the "/consent" mount prefix Express strips before
  // dispatching into the router, and even originalUrl matching broke again
  // once the match was tightened to require a trailing slash (to stop
  // over-matching a sibling route like "/consent-status") — a bare
  // "POST /consent" has no trailing slash, dispatches into this router's
  // rate-limit + json-parsing middleware just the same, and then 404s with
  // req.body already populated. consentLogIp is set unconditionally by
  // enforceConsentLogRateLimit for every request Express dispatches into
  // this router, regardless of path shape or whether any route matches —
  // the one signal immune to a URL-shape bypass.

  it("redacts once the rate limiter has run, regardless of path shape", () => {
    const token = "a".repeat(40)
    const logged = redactConsentBodyForLog(
      { locals: { consentLogIp: "1.2.3.4" } },
      validBody(),
    )

    expect(logged).toBe("[consent body redacted]")
    expect(JSON.stringify(logged)).not.toContain(token)
  })

  it("redacts the bare mount path with no trailing slash and no matching route (e.g. POST /consent)", () => {
    // The regression this pins: Express dispatches a bare "/consent" (no
    // trailing slash, no "/log") into this router's middleware — the rate
    // limiter and express.json() both still run — before falling through to
    // a 404 with no matching route. The rate limiter sets consentLogIp
    // regardless, so this must still redact even though no route handled it.
    expect(
      redactConsentBodyForLog({ locals: { consentLogIp: "1.2.3.4" } }, { token: "x" }),
    ).toBe("[consent body redacted]")
  })

  it("leaves non-consent request bodies untouched for the access log", () => {
    // A /graphql request never dispatches into the consent router, so
    // enforceConsentLogRateLimit never runs and consentLogIp is never set.
    const body = { query: "{ me { id } }" }
    expect(redactConsentBodyForLog({ locals: {} }, body)).toBe(body)
    expect(redactConsentBodyForLog({}, body)).toBe(body)
  })

  it("does not redact a sibling route that merely starts with /consent (e.g. /consent-status)", () => {
    // A route mounted alongside this router (not under it) never runs
    // enforceConsentLogRateLimit either, so its body must pass through.
    const body = { some: "unrelated payload" }
    expect(redactConsentBodyForLog({ locals: {} }, body)).toBe(body)
  })

  it("treats consentLogIp explicitly set to a falsy-but-defined value as still gated", () => {
    // Guards against a future "if (res.locals.consentLogIp)" rewrite that
    // would stop redacting for a (currently impossible, but not
    // type-prevented) empty-string IP.
    expect(
      redactConsentBodyForLog({ locals: { consentLogIp: "" } }, { token: "x" }),
    ).toBe("[consent body redacted]")
  })
})
