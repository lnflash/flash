import { Span as SdkSpan } from "@opentelemetry/sdk-trace-base"
import { Attributes, SpanStatusCode } from "@opentelemetry/api"

// Closed machine codes from the pinned public error map plus Apollo's standard
// codes. An arbitrary uppercase string is not evidence that it is nonsecret.
const errorCodes = new Set([
  "GRAPHQL_PARSE_FAILED",
  "GRAPHQL_VALIDATION_FAILED",
  "BAD_USER_INPUT",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "PERSISTED_QUERY_NOT_FOUND",
  "PERSISTED_QUERY_NOT_SUPPORTED",
  "INTERNAL_SERVER_ERROR",
  "CANT_PAY_SELF",
  "CODE_EXPIRED_ERROR",
  "DB_ERROR",
  "DEVICE_TOTP_REQUIRES_PHONE_UPGRADE",
  "DEALER_ERROR",
  "DEALER_OFFLINE",
  "EMAIL_ACCOUNT_ALREADY_EXISTS_ERROR",
  "EMAIL_ALREADY_ATTACHED_ERROR",
  "EMAIL_NOT_VERIFIED_ERROR",
  "ENTERED_DUST_AMOUNT",
  "FIREBASE_ERROR",
  "IBEX_ERROR",
  "INSUFFICIENT_BALANCE",
  "INVALID_COORDINATES",
  "INVALID_INPUT",
  "INVALID_LNURL",
  "INVALID_PHONE_METADATA_FOR_ONBOARDING_ERROR",
  "INVALID_TITLE",
  "INVOICE_DECODE_ERROR",
  "IP_NOT_ALLOWED_TO_ONBOARD_ERROR",
  "LIGHTNING_PAYMENT_ERROR",
  "LIQUIDITY_ERROR",
  "LND_OFFLINE",
  "NEW_ACCOUNT_WITHDRAWAL_RESTRICTED",
  "NOT_AUTHENTICATED",
  "NOT_AUTHORIZED",
  "NOT_FOUND",
  "ONCHAIN_FEE_ESTIMATION_ERROR",
  "ONCHAIN_PAYMENT_ERROR",
  "PHONE_ACCOUNT_ALREADY_EXISTS_ERROR",
  "PHONE_ACCOUNT_ALREADY_EXISTS_NEED_TO_SWEEP_FUNDS_ERROR",
  "PHONE_ALREADY_ATTACHED_ERROR",
  "PHONE_ALREADY_REGISTERED_TO_ANOTHER_USER",
  "PHONE_CODE_ERROR",
  "PHONE_NOT_ALLOWED_TO_ONBOARD_ERROR",
  "PHONE_PROVIDER_ERROR",
  "REJECTED_CAPTCHA_FAILED",
  "ROUTE_FINDING_ERROR",
  "SESSION_REFRESH_REQUIRED_ERROR",
  "TOO_MANY_REQUEST",
  "TRANSACTION_RESTRICTED",
  "TOTP_ENROLLMENT_UNAVAILABLE",
  "UNAUTHORIZED_COUNTRY_IP_FOR_REWARD",
  "UNAUTHORIZED_IP_FOR_REWARD",
  "UNAUTHORIZED_VPN_IP_FOR_REWARD",
  "UNEXPECTED_CLIENT_ERROR",
  "UNKNOWN_CLIENT_ERROR",
  "USERNAME_ERROR",
  "BANK_ACCOUNT_UPGRADE_REQUIRED",
  "BANK_ACCOUNT_NOT_FOUND",
  "BANK_ACCOUNT_DUPLICATE_NUMBER",
  "BANK_ACCOUNT_INVALID",
  "BRIDGE_INVALID_AMOUNT",
  "BRIDGE_BELOW_MINIMUM_WITHDRAWAL",
  "BRIDGE_DISABLED",
  "BRIDGE_ACCOUNT_LEVEL_ERROR",
  "BRIDGE_KYC_EMAIL_NOT_VERIFIED",
  "BRIDGE_KYC_COUNTRY_NOT_SUPPORTED",
  "BRIDGE_KYC_PHONE_REQUIRED",
  "BRIDGE_KYC_PENDING",
  "BRIDGE_KYC_REJECTED",
  "BRIDGE_KYC_OFFBOARDED",
  "BRIDGE_KYC_TIER_CEILING_EXCEEDED",
  "BRIDGE_CUSTOMER_NOT_FOUND",
  "BRIDGE_INSUFFICIENT_FUNDS",
  "BRIDGE_WITHDRAWAL_NET_AMOUNT_TOO_LOW",
  "BRIDGE_WITHDRAWAL_NOT_FOUND",
  "BRIDGE_WITHDRAWAL_ALREADY_INITIATED",
  "BRIDGE_WITHDRAWAL_SEND_OUTCOME_UNKNOWN",
  "BRIDGE_RATE_LIMIT",
  "BRIDGE_TIMEOUT",
  "BRIDGE_TRANSFER_FAILED",
  "BRIDGE_DEPOSIT_INSTRUCTIONS_MISSING",
  "BRIDGE_WEBHOOK_VALIDATION",
  "BRIDGE_API_ERROR",
  "BRIDGE_PLAID_NOT_AVAILABLE",
  "BRIDGE_INVALID_PLAID_TOKEN",
  "BRIDGE_ERROR",
])
const kinds = new Set(["execution", "payload", "mixed", "parse", "validation", "resolve"])
const phases = new Map([
  ["graphql.parse", "parse"],
  ["graphql.parseSchema", "parse"],
  ["graphql.validate", "validation"],
  ["graphql.validateSchema", "validation"],
  ["graphql.resolve", "resolve"],
])
export const safeGraphQLErrorCode = (value: unknown): string =>
  typeof value === "string" && errorCodes.has(value) ? value : "UNKNOWN"

export const graphQLErrorSummary = (
  errors: readonly unknown[],
  kind: "execution" | "payload",
  previous?: Attributes,
): Attributes => {
  const count = previous?.["graphql.error.count"]
  const priorCount =
    typeof count === "number" && Number.isInteger(count) && count > 0
      ? Math.min(count, 128)
      : 0
  const priorKind = previous?.["graphql.error.kind"]
  const currentCodes = errors.slice(0, 128).map((error) => {
    const record =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown; extensions?: { code?: unknown } })
        : undefined
    return safeGraphQLErrorCode(record?.extensions?.code ?? record?.code)
  })
  const currentCode = currentCodes.find((code) => code !== "UNKNOWN") ?? "UNKNOWN"
  const priorCode = safeGraphQLErrorCode(previous?.["graphql.error.code"])
  const previousCodes = previous?.["graphql.error.codes"]
  const codes = new Set(
    Array.isArray(previousCodes)
      ? previousCodes.slice(0, 16).map(safeGraphQLErrorCode)
      : [],
  )
  for (const code of currentCodes) codes.add(code)
  return {
    "graphql.error.count": Math.min(priorCount + errors.length, 128),
    "graphql.error.kind": priorCount > 0 && priorKind !== kind ? "mixed" : kind,
    "graphql.error.code": priorCode !== "UNKNOWN" ? priorCode : currentCode,
    "graphql.error.codes": [...codes].slice(0, 16),
  }
}

/** The pinned plugin records parse/validation exceptions outside responseHook. */
export const sanitizeGraphQLSpanForExport = (span: SdkSpan): void => {
  if (span.instrumentationLibrary.name !== "@opentelemetry/instrumentation-graphql")
    return
  const type = span.attributes["graphql.operation.type"]
  const operation =
    type === "query" || type === "mutation" || type === "subscription" ? type : undefined
  const phase = phases.get(span.name) ?? "execution"
  const exceptionEvents = span.events.filter(
    (event) => event.name === "exception" || event.name === "graphql.error",
  )
  const count = span.attributes["graphql.error.count"]
  const safeCount =
    typeof count === "number" && Number.isInteger(count) && count > 0
      ? Math.min(count, 128)
      : Math.min(exceptionEvents.length, 128)
  const failed = span.status.code === SpanStatusCode.ERROR || safeCount > 0
  const kind = span.attributes["graphql.error.kind"]
  const attributes: Attributes = operation ? { "graphql.operation.type": operation } : {}
  if (failed) {
    attributes["graphql.error.kind"] =
      typeof kind === "string" && kinds.has(kind) ? kind : phase
    attributes["graphql.error.count"] = Math.max(1, safeCount)
    attributes["graphql.error.code"] = safeGraphQLErrorCode(
      span.attributes["graphql.error.code"],
    )
    const codes = span.attributes["graphql.error.codes"]
    if (Array.isArray(codes))
      attributes["graphql.error.codes"] = [
        ...new Set(codes.slice(0, 16).map(safeGraphQLErrorCode)),
      ]
  }
  // Preserve no caller-selected operation/alias/path, original error object,
  // partially masked source, exception text/stack or status description.
  for (const key of Object.keys(span.attributes)) delete span.attributes[key]
  Object.assign(span.attributes, attributes)
  span.name = `graphql.${phase}`
  span.status = { code: failed ? SpanStatusCode.ERROR : span.status.code }
  const eventTime = exceptionEvents[0]?.time ?? span.startTime
  span.events.splice(0, span.events.length)
  if (failed)
    span.events.push({
      name: "graphql.error",
      time: eventTime,
      attributes: { ...attributes },
    })
}
