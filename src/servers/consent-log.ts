import express from "express"

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

consentLogRouter.use(express.json({ limit: "8kb" }))

consentLogRouter.post("/log", async (req, res) => {
  const ipString = UNSECURE_IP_FROM_REQUEST_OBJECT ? req.ip : req.headers["x-real-ip"]
  const ip = parseIps(ipString)

  const limited = await consumeLimiter({
    rateLimitConfig: RateLimitConfig.consentLog,
    keyToConsume: ip ?? "",
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

export default consentLogRouter
