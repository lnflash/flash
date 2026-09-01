import { ValidationError } from "@domain/shared"

// A consent record submitted by the getflash.io/invite landing page (ENG-568).
// The page has displayed a transactional/marketing consent flow since launch
// and POSTed it to /consent/log — an endpoint that did not exist, so every
// record was silently dropped. This validator is the endpoint's admission
// gate: the request body is anonymous, unauthenticated web input, so every
// field is bounded and everything unknown is discarded rather than stored.

const MAX_VERSION = 64
const MAX_URL = 2048
const MAX_USER_AGENT = 1024
const MAX_TIMESTAMP = 64
const MAX_TOKEN = 128
const MAX_PURPOSE = 256
const MAX_FREQUENCY = 64

// The invite token is secret-bearing (it redeems the invite). It is accepted
// here so the consent record can be tied to its invite, but callers must
// store only its hash — the same rule the invites collection follows.
export type ConsentLogSubmission = {
  version: string
  sourceUrl?: string
  userAgent?: string
  clientTimestamp?: string
  token?: string
  consents: {
    transactional: { optedIn: boolean; purpose?: string; frequency?: string }
    marketing: { optedIn: boolean; purpose?: string; frequency?: string }
  }
}

const boundedString = (
  value: unknown,
  max: number,
  field: string,
): string | undefined | ValidationError => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") return new ValidationError(`${field} must be a string`)
  if (value.length > max) return new ValidationError(`${field} exceeds ${max} chars`)
  return value
}

const checkedConsentLeg = (
  value: unknown,
  field: string,
): ConsentLogSubmission["consents"]["transactional"] | ValidationError => {
  if (typeof value !== "object" || value === null) {
    return new ValidationError(`${field} must be an object`)
  }
  const leg = value as Record<string, unknown>
  if (typeof leg.optedIn !== "boolean") {
    return new ValidationError(`${field}.optedIn must be a boolean`)
  }
  const purpose = boundedString(leg.purpose, MAX_PURPOSE, `${field}.purpose`)
  if (purpose instanceof ValidationError) return purpose
  const frequency = boundedString(leg.frequency, MAX_FREQUENCY, `${field}.frequency`)
  if (frequency instanceof ValidationError) return frequency
  return { optedIn: leg.optedIn, purpose, frequency }
}

export const checkedToConsentLogSubmission = (
  body: unknown,
): ConsentLogSubmission | ValidationError => {
  if (typeof body !== "object" || body === null) {
    return new ValidationError("body must be a JSON object")
  }
  const raw = body as Record<string, unknown>

  if (typeof raw.version !== "string" || raw.version.length === 0) {
    return new ValidationError("version is required")
  }
  if (raw.version.length > MAX_VERSION) {
    return new ValidationError(`version exceeds ${MAX_VERSION} chars`)
  }

  if (typeof raw.consents !== "object" || raw.consents === null) {
    return new ValidationError("consents is required")
  }
  const consents = raw.consents as Record<string, unknown>
  const transactional = checkedConsentLeg(
    consents.transactional,
    "consents.transactional",
  )
  if (transactional instanceof ValidationError) return transactional
  const marketing = checkedConsentLeg(consents.marketing, "consents.marketing")
  if (marketing instanceof ValidationError) return marketing

  // The page sends the page URL as `page`; accept `sourceUrl` too so the
  // field name can converge without breaking either sender.
  const sourceUrl = boundedString(raw.sourceUrl ?? raw.page, MAX_URL, "sourceUrl")
  if (sourceUrl instanceof ValidationError) return sourceUrl
  const userAgent = boundedString(raw.userAgent, MAX_USER_AGENT, "userAgent")
  if (userAgent instanceof ValidationError) return userAgent
  // Same convergence path as sourceUrl: the page sends `timestamp` today;
  // accept the canonical `clientTimestamp` too.
  const clientTimestamp = boundedString(
    raw.clientTimestamp ?? raw.timestamp,
    MAX_TIMESTAMP,
    "timestamp",
  )
  if (clientTimestamp instanceof ValidationError) return clientTimestamp
  const token = boundedString(raw.token, MAX_TOKEN, "token")
  if (token instanceof ValidationError) return token

  return {
    version: raw.version,
    sourceUrl,
    userAgent,
    clientTimestamp,
    token,
    consents: { transactional, marketing },
  }
}
