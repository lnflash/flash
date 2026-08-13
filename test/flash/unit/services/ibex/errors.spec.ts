import { ErrorLevel } from "@domain/shared"
import { ApiError, AuthenticationError, MAX_IBEX_MESSAGE_LENGTH } from "ibex-client"

import {
  CompletedInvoice,
  errorHandler,
  IbexError,
  ibexErrorDetail,
  InsufficientIbexBalance,
} from "@services/ibex/errors"

const insufficientDetail =
  "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164. account: 39c6e986-979b-40ab-9e7b-df18a9277a84"

// The client-facing message must strip IBEX's trailing internal account UUID.
const insufficientDetailStripped =
  "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164"

// The generated api SDK throws FetchError: message = statusText, `.status` =
// HTTP status, `.data` = parsed response body. Reproduce that shape without
// depending on the api package internals.
const fetchErrorShaped = (status: number, data: unknown): Error => {
  const err = new Error("Bad Request") as Error & { status: number; data: unknown }
  err.name = "FetchError"
  err.status = status
  err.data = data
  return err
}

describe("ibexErrorDetail", () => {
  it("extracts the `error` field from a FetchError-shaped body", () => {
    const err = fetchErrorShaped(400, { error: insufficientDetail })
    expect(ibexErrorDetail(err)).toBe(insufficientDetail)
  })

  it("falls back to the `message` field", () => {
    const err = fetchErrorShaped(400, { message: "invalid invoice" })
    expect(ibexErrorDetail(err)).toBe("invalid invoice")
  })

  it("returns a plain-text (non-JSON) body verbatim", () => {
    const err = fetchErrorShaped(400, "upstream said no")
    expect(ibexErrorDetail(err)).toBe("upstream said no")
  })

  it("prefers a structured ibexMessage (ibex-client > 3.2.0)", () => {
    const apiErr = new ApiError(new Error("Bad Request"))
    Object.assign(apiErr, { ibexMessage: insufficientDetail })
    expect(ibexErrorDetail(apiErr)).toBe(insufficientDetail)
  })

  it("returns undefined for errors without a body", () => {
    expect(ibexErrorDetail(new TypeError("fetch failed"))).toBeUndefined()
    expect(ibexErrorDetail(fetchErrorShaped(400, { code: 42 }))).toBeUndefined()
  })
})

// ibex-client >= 3.3.0 populates ibexMessage/ibexResponse/httpCode itself —
// these construct the real ApiError with no simulated fields, pinning the
// integration the ^3.3.0 bump claims to deliver. Since the payInvoice
// raw-fetch seam was collapsed (lnflash/flash#478), this is THE error shape
// every failed SDK call resolves with: ibex-client's wrapper catches whatever
// the generated SDK throws and hands errorHandler `new ApiError(thrown)`.
describe("ibex-client 3.3.0 integration", () => {
  it("ApiError extracts the body detail on construction", () => {
    const apiErr = new ApiError(fetchErrorShaped(400, { error: insufficientDetail }))

    expect(apiErr.httpCode).toBe(400)
    expect(apiErr.ibexMessage).toBe(insufficientDetail)
    expect(apiErr.ibexResponse).toEqual({ error: insufficientDetail })
    expect(ibexErrorDetail(apiErr)).toBe(insufficientDetail)
  })

  it("errorHandler classifies a real body-carrying ApiError, stripping the account id", () => {
    const apiErr = new ApiError(fetchErrorShaped(400, { error: insufficientDetail }))

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    const err = result as InsufficientIbexBalance
    expect(err.httpCode).toBe(400)
    expect(err.level).toBe(ErrorLevel.Info)
    expect(err.message).toBe(insufficientDetailStripped)
    expect(err.message).not.toContain("39c6e986-979b-40ab-9e7b-df18a9277a84")
    expect(err.detail).toBe(insufficientDetail)
  })

  it("classifies a 400 with a non-JSON insufficient-balance body", () => {
    const apiErr = new ApiError(fetchErrorShaped(400, "insufficient balance (text body)"))

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    expect((result as InsufficientIbexBalance).message).toBe(
      "insufficient balance (text body)",
    )
  })

  it("classifies case-insensitively, preserving IBEX's original casing in the detail", () => {
    const apiErr = new ApiError(
      fetchErrorShaped(400, { error: "Insufficient Balance. Current Balance: 5.000000" }),
    )

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    expect((result as InsufficientIbexBalance).message).toBe(
      "Insufficient Balance. Current Balance: 5.000000",
    )
  })

  it("classifies payment-already-prepared from a real body-carrying ApiError", () => {
    const apiErr = new ApiError(
      fetchErrorShaped(400, { error: "Payment Already Prepared" }),
    )

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(CompletedInvoice)
    expect((result as CompletedInvoice).level).toBe(ErrorLevel.Info)
  })

  it("errorHandler carries a real unclassified detail onto the generic IbexError", () => {
    const apiErr = new ApiError(fetchErrorShaped(400, { error: "invalid parameters" }))

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    const err = result as IbexError
    // an unrecognized IBEX 400 that logs only "FetchError: Bad Request" is the
    // debugging blindness this module exists to fix
    expect(err.httpCode).toBe(400)
    expect(err.level).toBe(ErrorLevel.Warn)
    expect(err.message).toContain("invalid parameters")
    // 3.3.0's ApiError already embeds the detail in its own message — the
    // unclassified carry must not append the same text a second time (the
    // duplicated detail would reach logs and Discord alert embeds)
    expect(err.message.split("invalid parameters").length - 1).toBe(1)
  })

  it("keeps the message bounded when the body exceeds ibex-client's cap", () => {
    // Cloudflare-style outage: IBEX's proxy returns a full HTML error page,
    // which arrives as a plain-text body far over MAX_IBEX_MESSAGE_LENGTH.
    // ApiError embeds only the capped copy (`ibexMessage`) in its message and
    // errorHandler derives the detail from that same capped extraction, so
    // the dedupe guard matches and nothing multi-KB is ever prepended into
    // logs or Discord alert embeds. The full body survives only on the local
    // ApiError's `ibexResponse`, which does not reach the returned IbexError.
    const hugeBody = `<html>cf-502 error page</html>${"x".repeat(
      MAX_IBEX_MESSAGE_LENGTH * 4,
    )}`
    const raw = fetchErrorShaped(502, hugeBody)
    const rawStackLength = (raw.stack as string).length

    const result = errorHandler(new ApiError(raw))

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    const err = result as IbexError
    expect(err.httpCode).toBe(502)
    // the truncated detail appears exactly once...
    const truncatedDetail = `${hugeBody.slice(0, MAX_IBEX_MESSAGE_LENGTH)}... [truncated]`
    expect(err.message.split(truncatedDetail).length - 1).toBe(1)
    // ... the capped prefix itself is not duplicated (truncated + full copy)...
    expect(err.message.split(hugeBody.slice(0, MAX_IBEX_MESSAGE_LENGTH)).length - 1).toBe(
      1,
    )
    // ... the full uncapped body never reaches the message...
    expect(err.message).not.toContain(hugeBody)
    // ... and the whole message stays bounded: stack + capped detail + framing
    expect(err.message.length).toBeLessThan(
      rawStackLength + MAX_IBEX_MESSAGE_LENGTH + 100,
    )
  })

  it("maps an ApiError wrapping a network-level failure to a generic IbexError without a status", () => {
    // the wrapper catches TypeError("fetch failed") like anything else thrown
    const result = errorHandler(new ApiError(new TypeError("fetch failed")))

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    const err = result as IbexError
    expect(err.httpCode).toBeUndefined()
    expect(err.level).toBe(ErrorLevel.Warn)
  })

  it("tolerates an ApiError wrapping a non-Error throwable", () => {
    // `throw "boom"` somewhere under the SDK still resolves to ApiError("boom")
    const result = errorHandler(new ApiError("boom" as unknown as Error))

    expect(result).toBeInstanceOf(IbexError)
    expect((result as IbexError).httpCode).toBeUndefined()
  })
})

describe("errorHandler", () => {
  it("classifies an ApiError whose message carries the insufficient-balance text", () => {
    // flash's raw-fetch path embeds the body text in the wrapped message
    const apiErr = new ApiError(
      new Error(`IBEX /pay failed: 400 — {"error":"${insufficientDetail}"}`),
    )

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    const err = result as InsufficientIbexBalance
    expect(err.level).toBe(ErrorLevel.Info)
    // client-facing message is clean — never the wrapped stack trace
    expect(err.message).toBe("insufficient balance")
    expect(err.message).not.toContain("  at ")
  })

  it("classifies a structured ibexMessage (ibex-client > 3.2.0), stripping the account id", () => {
    const apiErr = new ApiError(new Error("Bad Request"))
    Object.assign(apiErr, { ibexMessage: insufficientDetail })

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    const err = result as InsufficientIbexBalance
    // client-facing message never exposes IBEX's internal account UUID
    expect(err.message).toBe(insufficientDetailStripped)
    expect(err.message).not.toContain("account:")
    expect(err.message).not.toContain("39c6e986-979b-40ab-9e7b-df18a9277a84")
    // the unstripped vendor text is preserved for logs/spans
    expect(err.detail).toBe(insufficientDetail)
  })

  it("carries the body detail on the unclassified ApiError fall-through", () => {
    // future body-carrying ApiError shape (lnflash/ibex-client#12) whose text
    // matches no needle — the detail must still reach the logged message
    const apiErr = new ApiError(new Error("Bad Request"))
    Object.assign(apiErr, { ibexMessage: "invalid parameters" })
    const originalMessage = apiErr.message

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    const err = result as IbexError
    expect(err.level).toBe(ErrorLevel.Warn)
    expect(err.message).toContain("invalid parameters")
    // the caller's error is not mutated — a fresh IbexError carries the detail
    expect(apiErr.message).toBe(originalMessage)
  })

  it("maps an ApiError with no extractable body (stack-only message) to a generic IbexError", () => {
    // when the response carries no body, 3.3.0's ApiError message is only the
    // wrapped FetchError stack ("FetchError: Bad Request\n    at ...")
    const apiErr = new ApiError(fetchErrorShaped(400, undefined))

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    // the status survives even when the response carried no body
    expect((result as IbexError).httpCode).toBe(400)
  })

  it("classifies payment-already-prepared as CompletedInvoice", () => {
    const apiErr = new ApiError(new Error("payment already prepared"))

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(CompletedInvoice)
    expect((result as CompletedInvoice).level).toBe(ErrorLevel.Info)
  })

  it("classifies case-insensitively — a vendor rewording must not revert to the generic path", () => {
    const insufficientErr = new ApiError(new Error("Bad Request"))
    Object.assign(insufficientErr, { ibexMessage: "Insufficient Balance" })
    expect(errorHandler(insufficientErr)).toBeInstanceOf(InsufficientIbexBalance)

    const preparedErr = new ApiError(new Error("Payment Already Prepared"))
    expect(errorHandler(preparedErr)).toBeInstanceOf(CompletedInvoice)
  })

  it("maps AuthenticationError to a critical IbexError", () => {
    const result = errorHandler(new AuthenticationError("auth failed"))

    expect(result).toBeInstanceOf(IbexError)
    expect((result as IbexError).level).toBe(ErrorLevel.Critical)
  })

  it("passes successful responses through untouched", () => {
    const response = { transaction: { id: "t-1" } }
    expect(errorHandler(response)).toBe(response)
  })
})
