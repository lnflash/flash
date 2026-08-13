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
 *    typically `{ "error": "..." }`, sometimes `{ "message": "..." }` or text.
 *    No live caller passes this shape anymore — the payInvoice raw-fetch seam
 *    was collapsed onto the SDK path (lnflash/flash#478) — but the fallback is
 *    a few lines and keeps this helper safe for any future raw caller.
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
// classification to the generic path. errorHandler classifies through this
// helper — never add a needle anywhere else.
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
    // against `message` otherwise — a defensive fallback for shapes that only
    // embed the body text in the message. Body-carrying shapes are checked
    // first so a stack that happens to contain a needle can't misclassify.
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
