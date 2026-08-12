import { ErrorLevel } from "@domain/shared"
import { ApiError, AuthenticationError } from "ibex-client"

import {
  CompletedInvoice,
  errorHandler,
  httpErrorHandler,
  IbexError,
  ibexErrorDetail,
  InsufficientIbexBalance,
} from "@services/ibex/errors"

const insufficientDetail =
  "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164. account: 39c6e986-979b-40ab-9e7b-df18a9277a84"

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

  it("classifies a structured ibexMessage (ibex-client > 3.2.0) with full detail", () => {
    const apiErr = new ApiError(new Error("Bad Request"))
    Object.assign(apiErr, { ibexMessage: insufficientDetail })

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    expect((result as InsufficientIbexBalance).message).toBe(insufficientDetail)
  })

  it("maps a pinned-version SDK-path ApiError (stack-only message) to a generic IbexError", () => {
    // ibex-client@3.2.0 discards the response body: message is only the
    // wrapped FetchError stack ("FetchError: Bad Request\n    at ...")
    const apiErr = new ApiError(fetchErrorShaped(400, undefined))

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
  })

  it("classifies payment-already-prepared as CompletedInvoice", () => {
    const apiErr = new ApiError(new Error("payment already prepared"))

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(CompletedInvoice)
    expect((result as CompletedInvoice).level).toBe(ErrorLevel.Info)
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

describe("httpErrorHandler", () => {
  it("classifies a 400 with a JSON insufficient-balance body", () => {
    const raw = fetchErrorShaped(400, { error: insufficientDetail })

    const result = httpErrorHandler(raw)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    const err = result as InsufficientIbexBalance
    expect(err.httpCode).toBe(400)
    expect(err.level).toBe(ErrorLevel.Info)
    // full IBEX detail is preserved for the client-facing message
    expect(err.message).toBe(insufficientDetail)
  })

  it("classifies a 400 with a non-JSON insufficient-balance body", () => {
    const raw = fetchErrorShaped(400, "insufficient balance (text body)")

    const result = httpErrorHandler(raw)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    expect((result as InsufficientIbexBalance).message).toBe(
      "insufficient balance (text body)",
    )
  })

  it("maps other 400s to a generic IbexError, keeping the status", () => {
    const raw = fetchErrorShaped(400, { error: "invalid parameters" })

    const result = httpErrorHandler(raw)

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    const err = result as IbexError
    expect(err.httpCode).toBe(400)
    expect(err.level).toBe(ErrorLevel.Warn)
  })

  it("classifies payment-already-prepared as CompletedInvoice", () => {
    const raw = fetchErrorShaped(400, { error: "payment already prepared" })

    const result = httpErrorHandler(raw)

    expect(result).toBeInstanceOf(CompletedInvoice)
  })

  it("maps network-level failures to a generic IbexError without a status", () => {
    const result = httpErrorHandler(new TypeError("fetch failed"))

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    expect((result as IbexError).httpCode).toBeUndefined()
  })

  it("tolerates non-Error throwables", () => {
    const result = httpErrorHandler("boom")

    expect(result).toBeInstanceOf(IbexError)
  })
})
