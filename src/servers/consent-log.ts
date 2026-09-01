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
consentLogRouter.use(cors({ origin: "https://getflash.io" }))

consentLogRouter.use(express.json({ limit: "8kb" }))

consentLogRouter.post("/log", async (req, res) => {
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

export default consentLogRouter
