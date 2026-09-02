import cors from "cors"
import express, { NextFunction, Request, Response } from "express"

import { UNSECURE_IP_FROM_REQUEST_OBJECT } from "@config"
import { parseIps } from "@domain/accounts-ips"
import { checkedToConsentLogSubmission } from "@domain/consent-log"
import { RateLimitConfig } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { ValidationError } from "@domain/shared"
import { baseLogger } from "@services/logger"
import { ConsentLogRepository } from "@services/mongoose/models/consent-log"
import { consumeLimiter } from "@services/rate-limit"
import { hashToken } from "@utils"

// POST /consent/log — compliance evidence from the getflash.io/invite landing
// page (ENG-568). The page has sent these records since launch with the call
// wrapped fail-open; this endpoint finally persists them.
//
// Anonymous by design: the submitter is an invitee with no session. That makes
// this a public unauthenticated write, so it is deliberately narrow —
// tiny body cap, strict field validation, per-IP rate limit, and the invite
// token stored only as a hash. Responses carry no body on success (204) and
// no internals on failure.

const consentLogRouter = express.Router({ caseSensitive: true })

// The submitter is a browser on getflash.io posting cross-origin to
// api.flashapp.me — without CORS the preflight fails and the (fail-open)
// page call silently drops every record. No credentials involved.
// Both the apex and www hosts are allowed: if a visitor reaches the invite
// page at www.getflash.io (or the www→apex redirect hasn't happened before
// the page fires its fail-open POST), an apex-only allowlist would silently
// drop those records — the original incident, resurrected for that subset.
consentLogRouter.use(cors({ origin: ["https://getflash.io", "https://www.getflash.io"] }))

// Resolves the caller's IP and consumes the per-IP rate limit BEFORE
// express.json() gets a chance to run. This has to be router-level
// middleware, not logic inside the /log handler: express.json() routes a
// parse failure (oversized body -> "entity.too.large", malformed JSON ->
// "entity.parse.failed") straight to the error handler below, skipping the
// route handler entirely. If the limiter were only consumed inside that
// handler, an attacker could flood this endpoint at wire speed with
// oversized/malformed bodies and never touch the limiter — only a
// well-formed submission would ever be capped. Consuming here means every
// request that reaches this router is charged against the bucket
// regardless of whether its body goes on to parse.
const enforceConsentLogRateLimit = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Same header conventions as the rest of the public surface: x-real-ip
  // from ingress, x-forwarded-for as fallback (graphql-main-server does the
  // same). A missing IP would collapse the rate limit into one global
  // bucket, so treat it as an infrastructure fault, not an open door.
  const ipString = UNSECURE_IP_FROM_REQUEST_OBJECT
    ? req.ip
    : req.headers["x-real-ip"] || req.headers["x-forwarded-for"]
  const ip = parseIps(ipString)
  if (!ip) {
    baseLogger.error(
      { headers: { "x-real-ip": req.headers["x-real-ip"] } },
      "consent-log request has no resolvable client IP",
    )
    return res.status(503).json({ error: "temporarily unavailable" })
  }

  const limited = await consumeLimiter({
    rateLimitConfig: RateLimitConfig.consentLog,
    keyToConsume: ip,
  })
  if (limited instanceof RateLimiterExceededError) {
    return res.status(429).json({ error: "too many requests" })
  }
  if (limited instanceof Error) {
    // Rate-limit store fault. Evidence collection must not become a way to
    // probe infrastructure health — refuse rather than fail open on a public
    // write endpoint.
    baseLogger.error({ error: limited }, "consent-log rate limiter unavailable")
    return res.status(503).json({ error: "temporarily unavailable" })
  }

  // Hand the resolved IP to the route handler (it's stored on the record)
  // without re-deriving it from headers a second time.
  res.locals.consentLogIp = ip
  return next()
}

consentLogRouter.use(enforceConsentLogRateLimit)

consentLogRouter.use(express.json({ limit: "8kb" }))

consentLogRouter.post("/log", async (req, res) => {
  const ip = res.locals.consentLogIp as IpAddress

  const submission = checkedToConsentLogSubmission(req.body)
  if (submission instanceof ValidationError) {
    return res.status(400).json({ error: submission.message })
  }

  try {
    await ConsentLogRepository.create({
      version: submission.version,
      consents: submission.consents,
      // Raw token never touches disk — same rule the invites collection
      // follows (it stores tokenHash only).
      inviteTokenHash: submission.token ? hashToken(submission.token) : undefined,
      sourceUrl: submission.sourceUrl,
      userAgent: submission.userAgent,
      clientTimestamp: submission.clientTimestamp,
      ip,
      receivedAt: new Date(),
    })
  } catch (err) {
    baseLogger.error({ error: err }, "consent-log persist failed")
    return res.status(500).json({ error: "could not record consent" })
  }

  return res.status(204).send()
})

// Body-parser failures (malformed JSON, oversized body) would otherwise fall
// through to Express's default handler, which answers with HTML — including a
// stack trace outside production. Keep the contract: JSON only, no internals.
consentLogRouter.use(
  (
    err: Error & { type?: string },
    _req: Request,
    res: Response,
    // Express identifies an error handler by its arity — the 4th arg is
    // required even though this terminal handler never calls it.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: NextFunction,
  ) => {
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: "body too large" })
    }
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid body" })
    }
    baseLogger.error({ error: err }, "consent-log unhandled error")
    return res.status(500).json({ error: "could not record consent" })
  },
)

// Used by the app-level PinoHttp access logger (graphql-server.ts). pino-http
// re-evaluates customProps at response finish — by then express.json() inside
// this router has populated req.body, so logging the raw body would write the
// raw invite token to the access logs on every status path (204/400/429/503).
// Same rule as the invites collection: the raw token never touches disk.
// (authRouter dodges this by mounting BEFORE PinoHttp; the consent router
// mounts after it so the public write path still gets an access-log line.)
// Keyed on originalUrl, never url: Express 4 strips the mount path off
// req.url when dispatching into a router mounted at "/consent" (req.url
// becomes "/log") and only restores it on a later next() that never comes,
// because every consent handler terminates the response. pino-http evaluates
// customProps again at response-finish against that mutated req — the moment
// req.body actually holds the parsed (token-bearing) payload — so matching on
// req.url would pass raw tokens straight into the access log.
//
// Matched with the trailing slash ("/consent/", not "/consent") so this
// stays scoped to this router's actual mount point — a bare "/consent"
// prefix would also swallow any future unrelated route mounted alongside it
// (e.g. "/consent-status", "/consent-preferences"), redacting bodies that
// have nothing to do with this router.
//
// Compared lower-cased on both sides: the app-level mount
// (graphql-server.ts, `app.use("/consent", consentLogRouter)`) runs on a
// bare express() with no "case sensitive routing" setting, so Express
// matches that mount case-insensitively regardless of this router's own
// `caseSensitive: true` (which only governs matching *within* the router,
// e.g. "/log" vs "/Log"). A request to "/CONSENT/log" still dispatches into
// this router and still persists — its originalUrl is just differently
// cased. A plain case-sensitive startsWith here would miss that request
// and leak its raw invite token into the access log.
export const redactConsentBodyForLog = (req: {
  originalUrl?: string
  url?: string
  body?: unknown
}) =>
  (req.originalUrl ?? req.url)?.toLowerCase().startsWith("/consent/")
    ? "[consent body redacted]"
    : req.body

export default consentLogRouter
