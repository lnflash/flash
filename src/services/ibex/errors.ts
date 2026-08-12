import { DomainError, ErrorLevel } from "@domain/shared"
import {
  ApiError,
  AuthenticationError,
  IbexClientError,
  UnexpectedResponseError,
} from "ibex-client"

export class IbexError extends DomainError {
  readonly type: string
  readonly level: ErrorLevel
  readonly httpCode?: number

  constructor(err: Error, level: ErrorLevel = ErrorLevel.Critical) {
    super(err)
    this.type = err.name
    this.level = level
    this.httpCode = err instanceof ApiError ? err.httpCode : undefined
  }
}

export class UnexpectedIbexResponse extends IbexError {
  constructor(message: string, level?: ErrorLevel) {
    super(new UnexpectedResponseError(message), level)
  }
}

export class ParseError extends IbexError {}

export class InsufficientIbexBalance extends IbexError {
  // Full vendor detail, preserved verbatim for logs/spans (pino's error
  // serializer picks up own enumerable properties).
  readonly detail?: string

  constructor(err: Error, level: ErrorLevel = ErrorLevel.Info, detail?: string) {
    super(err, level)
    this.detail = detail
    // error-map forwards `message` to the GraphQL client verbatim (the
    // INSUFFICIENT_BALANCE case sets message = error.message). Keep it the
    // human-readable IBEX detail — never the wrapped error's stack trace —
    // but strip the trailing internal IBEX account UUID ("... account: <id>"):
    // end users must never see vendor-internal identifiers on the failure
    // screen. The unstripped detail stays on `this.detail`.
    this.message =
      detail?.replace(/[.,]?\s*account:\s*\S+\s*$/i, "") ?? "insufficient balance"
  }
}
export class CompletedInvoice extends IbexError {}

/**
 * Best-effort extraction of the IBEX error text from a failed call.
 * Shapes handled:
 *  - ibex-client > 3.2.0 (lnflash/ibex-client#6): ApiError carries the parsed
 *    body on `ibexResponse` and the extracted text on `ibexMessage`
 *  - the generated api SDK's FetchError: parsed JSON body on `.data`,
 *    typically `{ "error": "..." }`, sometimes `{ "message": "..." }` or text
 */
export const ibexErrorDetail = (e: unknown): string | undefined => {
  if (typeof e !== "object" || e === null) return undefined
  const { ibexMessage, data } = e as { ibexMessage?: unknown; data?: unknown }
  if (typeof ibexMessage === "string" && ibexMessage !== "") return ibexMessage
  if (typeof data === "string" && data !== "") return data
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>
    if (typeof record.error === "string" && record.error !== "") return record.error
    if (typeof record.message === "string" && record.message !== "") return record.message
  }
  return undefined
}

// The single needle list mapping IBEX error prose to a typed error class.
// Matching is case-insensitive (the haystack is lowercased once here) so a
// vendor rewording like "Insufficient Balance" cannot silently revert
// classification to the generic path. Both errorHandler and httpErrorHandler
// classify through this helper — never add a needle anywhere else.
const classifyIbexErrorText = (
  text: string,
): typeof InsufficientIbexBalance | typeof CompletedInvoice | undefined => {
  const haystack = text.toLowerCase()
  if (haystack.includes("insufficient balance")) return InsufficientIbexBalance
  if (haystack.includes("payment already prepared")) return CompletedInvoice
  return undefined
}

export const errorHandler = <T>(
  e: T | IbexClientError | AuthenticationError | ApiError,
): T | IbexError => {
  if (e instanceof AuthenticationError) return new IbexError(e, ErrorLevel.Critical)
  if (e instanceof ApiError) {
    // Classify against the structured body detail when the error carries one
    // (ibex-client >= 3.3.0's ApiError extracts it onto `ibexMessage`), and
    // against `message` otherwise — flash's raw-fetch path embeds the body
    // text in the message. Body-carrying shapes are checked first so a stack
    // that happens to contain a needle can't misclassify.
    const detail = ibexErrorDetail(e)
    const classified = classifyIbexErrorText(detail ?? e.message)
    if (classified === InsufficientIbexBalance)
      return new InsufficientIbexBalance(e, ErrorLevel.Info, detail)
    if (classified === CompletedInvoice) return new CompletedInvoice(e, ErrorLevel.Info)
    // Unclassified path: an unrecognized IBEX 400 must still log what IBEX
    // actually said. ibex-client >= 3.3.0's ApiError already appends
    // "IBEX response (<code>): <detail>" to its own message, so only carry
    // the detail when the message doesn't already contain it (older or raw
    // shapes with a stack-only message). Build a new IbexError rather than
    // mutating `e`, which the caller may still hold.
    if (detail !== undefined) {
      const generic = new IbexError(e, ErrorLevel.Warn)
      if (!generic.message.includes(detail))
        generic.message = `${detail}\n${generic.message}`
      return generic
    }
  }
  if (e instanceof IbexClientError) return new IbexError(e, ErrorLevel.Warn)
  return e
}

/**
 * Classify a raw error thrown by the generated IBEX SDK (or fetch) for call
 * sites that invoke the SDK through `Ibex.authentication.withAuth` themselves
 * and route the caught error here (the payInvoice raw-fetch seam). The seam
 * predates ibex-client@3.3.0: 3.2.0's ApiError kept only `httpCode` and
 * discarded the JSON error body that distinguishes e.g. "insufficient
 * balance" from any other 400 (lnflash/ibex-client#6). As of 3.3.0, ApiError
 * extracts the body itself (`ibexResponse` / `ibexMessage`) and errorHandler
 * classifies it through the standard path — this handler remains as
 * defense-in-depth for the raw-fetch seam until that seam is collapsed
 * (lnflash/flash#478).
 */
export const httpErrorHandler = (e: unknown): IbexError => {
  const raw = e instanceof Error ? e : new Error(String(e))
  if (raw instanceof AuthenticationError) return new IbexError(raw, ErrorLevel.Critical)
  // ApiError's constructor keeps `.status` as httpCode, which IbexError reads.
  const wrapped = raw instanceof IbexClientError ? raw : new ApiError(raw)
  // Derive the detail from `wrapped`, never from `raw`. For a raw FetchError,
  // ApiError's own extraction (`ibexMessage`) is capped at ibex-client's
  // MAX_IBEX_MESSAGE_LENGTH, while reading straight off `raw.data` is not:
  // comparing an uncapped detail against the capped copy embedded in
  // `wrapped.message` would defeat the dedupe guard below for any body over
  // the cap — exactly the Cloudflare-HTML-error-page outage the cap exists
  // for — and prepend the full multi-KB body onto every failing call's
  // message. When `raw` is already an IbexClientError, wrapped === raw and
  // the extraction is unchanged. The uncapped body stays on
  // `wrapped.ibexResponse` for anyone who needs it verbatim.
  const detail = ibexErrorDetail(wrapped)
  const classified = classifyIbexErrorText(detail ?? raw.message)
  if (classified === InsufficientIbexBalance)
    return new InsufficientIbexBalance(wrapped, ErrorLevel.Info, detail)
  if (classified === CompletedInvoice)
    return new CompletedInvoice(wrapped, ErrorLevel.Info)
  // Unclassified path: an unrecognized IBEX 400 must still log what IBEX
  // actually said, not just "FetchError: Bad Request" + stack. The ApiError
  // constructed above already embeds the extracted detail in its message
  // (ibex-client >= 3.3.0), so only carry the detail when the message doesn't
  // already contain it — never append the same text twice.
  if (
    detail !== undefined &&
    !(raw instanceof IbexClientError) &&
    !wrapped.message.includes(detail)
  )
    wrapped.message = `${detail}\n${wrapped.message}`
  return new IbexError(wrapped, ErrorLevel.Warn)
}
