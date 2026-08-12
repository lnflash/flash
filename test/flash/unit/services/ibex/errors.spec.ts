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
// integration the ^3.3.0 bump claims to deliver.
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
    expect(err.message).toBe(insufficientDetailStripped)
    expect(err.message).not.toContain("39c6e986-979b-40ab-9e7b-df18a9277a84")
    expect(err.detail).toBe(insufficientDetail)
  })

  it("errorHandler carries a real unclassified detail onto the generic IbexError", () => {
    const apiErr = new ApiError(fetchErrorShaped(400, { error: "invalid parameters" }))

    const result = errorHandler(apiErr)

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    expect((result as IbexError).message).toContain("invalid parameters")
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

describe("httpErrorHandler", () => {
  it("classifies a 400 with a JSON insufficient-balance body", () => {
    const raw = fetchErrorShaped(400, { error: insufficientDetail })

    const result = httpErrorHandler(raw)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    const err = result as InsufficientIbexBalance
    expect(err.httpCode).toBe(400)
    expect(err.level).toBe(ErrorLevel.Info)
    // client-facing message keeps the IBEX detail minus the internal account UUID
    expect(err.message).toBe(insufficientDetailStripped)
    expect(err.message).not.toContain("account:")
    // the unstripped vendor text is preserved for logs/spans
    expect(err.detail).toBe(insufficientDetail)
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
    // the extracted body detail must survive the generic path — an
    // unrecognized IBEX 400 that logs only "FetchError: Bad Request" is the
    // debugging blindness this module exists to fix
    expect(err.message).toContain("invalid parameters")
  })

  it("keeps the generic path unchanged when the error carries no body detail", () => {
    const raw = fetchErrorShaped(500, undefined)

    const result = httpErrorHandler(raw)

    expect(result).toBeInstanceOf(IbexError)
    expect((result as IbexError).httpCode).toBe(500)
  })

  it("classifies insufficient-balance case-insensitively", () => {
    const raw = fetchErrorShaped(400, {
      error: "Insufficient Balance. Current Balance: 5.000000",
    })

    const result = httpErrorHandler(raw)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    // the client-facing detail keeps IBEX's original casing
    expect((result as InsufficientIbexBalance).message).toBe(
      "Insufficient Balance. Current Balance: 5.000000",
    )
  })

  it("classifies payment-already-prepared case-insensitively", () => {
    const raw = fetchErrorShaped(400, { error: "Payment Already Prepared" })

    const result = httpErrorHandler(raw)

    expect(result).toBeInstanceOf(CompletedInvoice)
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
