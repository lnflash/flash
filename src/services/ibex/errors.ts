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
    // Classify against the structured body detail when the error carries one,
    // and against `message` otherwise (flash's raw-fetch path embeds the body
    // text in the message; ibex-client@3.2.0's ApiError message is only the
    // wrapped stack, which is why body-carrying shapes are checked first).
    const detail = ibexErrorDetail(e)
    const classified = classifyIbexErrorText(detail ?? e.message)
    if (classified === InsufficientIbexBalance)
      return new InsufficientIbexBalance(e, ErrorLevel.Info, detail)
    if (classified === CompletedInvoice) return new CompletedInvoice(e, ErrorLevel.Info)
    // Unclassified path: mirror httpErrorHandler's carry — an unrecognized
    // IBEX 400 whose ApiError has a stack-only message must still log what
    // IBEX actually said. Build a new IbexError rather than mutating `e`,
    // which the caller may still hold.
    if (detail !== undefined) {
      const generic = new IbexError(e, ErrorLevel.Warn)
      generic.message = `${detail}\n${generic.message}`
      return generic
    }
  }
  if (e instanceof IbexClientError) return new IbexError(e, ErrorLevel.Warn)
  return e
}

/**
 * Classify a raw error thrown by the generated IBEX SDK (or fetch) before
 * ibex-client's ApiError wrapper can discard the response body. With the
 * pinned ibex-client@3.2.0, ApiError keeps only `httpCode` — the JSON error
 * body that distinguishes e.g. "insufficient balance" from any other 400 only
 * exists on the underlying FetchError's `.data` (lnflash/ibex-client#6).
 * Call sites that need body-level classification invoke the SDK through
 * `Ibex.authentication.withAuth` themselves and route the caught error here.
 */
export const httpErrorHandler = (e: unknown): IbexError => {
  const raw = e instanceof Error ? e : new Error(String(e))
  if (raw instanceof AuthenticationError) return new IbexError(raw, ErrorLevel.Critical)
  const detail = ibexErrorDetail(raw)
  // ApiError's constructor keeps `.status` as httpCode, which IbexError reads.
  const wrapped = raw instanceof IbexClientError ? raw : new ApiError(raw)
  const classified = classifyIbexErrorText(detail ?? raw.message)
  if (classified === InsufficientIbexBalance)
    return new InsufficientIbexBalance(wrapped, ErrorLevel.Info, detail)
  if (classified === CompletedInvoice)
    return new CompletedInvoice(wrapped, ErrorLevel.Info)
  // Unclassified path: ApiError's message is only the wrapped stack, so carry
  // the extracted body detail into it — an unrecognized IBEX 400 must still
  // log what IBEX actually said, not just "FetchError: Bad Request" + stack.
  if (detail !== undefined && !(raw instanceof IbexClientError))
    wrapped.message = `${detail}\n${wrapped.message}`
  return new IbexError(wrapped, ErrorLevel.Warn)
}
