import {
  isIbexAvailable,
  markIbexUnavailable,
  resetIbexAvailability,
} from "@services/ibex/availability"
import { ApiError } from "ibex-client"

import { errorHandler, IbexUnavailableError } from "@services/ibex/errors"

// A hand-rolled clock keeps the half-open window assertable without timers.
const clock = (initial: number) => {
  let now = initial
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("isIbexAvailable", () => {
  beforeEach(() => {
    resetIbexAvailability()
  })

  it("is available until something reports the rail as unreachable", () => {
    const now = clock(0)

    expect(isIbexAvailable(now.now)).toBe(true)
  })

  it("degrades for the whole open window after a trip", () => {
    const now = clock(1_000)
    markIbexUnavailable(now.now)

    expect(isIbexAvailable(now.now)).toBe(false)

    now.advance(2_999)
    expect(isIbexAvailable(now.now)).toBe(false)
  })

  it("half-opens after the window: one probe is allowed through", () => {
    const now = clock(0)
    markIbexUnavailable(now.now)

    now.advance(3_000)
    // First call past the window forgets the trip and returns true so the
    // caller actually hits the rail...
    expect(isIbexAvailable(now.now)).toBe(true)
    // ... and the circuit stays closed for later calls in the same tick.
    expect(isIbexAvailable(now.now)).toBe(true)
  })

  it("re-opens on the next trip after half-opening", () => {
    const now = clock(0)
    markIbexUnavailable(now.now)

    now.advance(3_000)
    expect(isIbexAvailable(now.now)).toBe(true)

    // Still not answering: the trip is recorded at the current time, so the
    // following calls degrade again rather than all probing at once.
    markIbexUnavailable(now.now)
    expect(isIbexAvailable(now.now)).toBe(false)
  })

  it("a fresh trip replaces an older one", () => {
    const now = clock(0)
    markIbexUnavailable(now.now)

    now.advance(2_000)
    markIbexUnavailable(now.now)

    // 2_000 ms after the first trip — but only 0 ms after the second.
    expect(isIbexAvailable(now.now)).toBe(false)
    now.advance(1_000)
    expect(isIbexAvailable(now.now)).toBe(false)
    now.advance(2_000)
    expect(isIbexAvailable(now.now)).toBe(true)
  })

  it("resetIbexAvailability clears the state immediately", () => {
    const now = clock(0)
    markIbexUnavailable(now.now)
    expect(isIbexAvailable(now.now)).toBe(false)

    resetIbexAvailability()
    expect(isIbexAvailable(now.now)).toBe(true)
  })
})

describe("errorHandler trips the breaker", () => {
  beforeEach(() => {
    resetIbexAvailability()
  })

  it("treats a status-less ApiError as an unavailable rail", () => {
    const now = clock(5_000)

    const result = errorHandler(new ApiError(new TypeError("fetch failed")))

    expect(result).toBeInstanceOf(IbexUnavailableError)
    expect((result as IbexUnavailableError).httpCode).toBeUndefined()
    expect(isIbexAvailable(now.now)).toBe(false)
  })

  it("leaves the circuit alone when the rail answered with a status", () => {
    const now = clock(5_000)
    const raw = new Error("Bad Request") as Error & { status: number; data: unknown }
    raw.name = "FetchError"
    raw.status = 400
    raw.data = { error: "invalid invoice" }

    const result = errorHandler(new ApiError(raw))

    expect(result).toBeInstanceOf(Error)
    expect(result).not.toBeInstanceOf(IbexUnavailableError)
    // A refusal carries information; the next call should still try the rail.
    expect(isIbexAvailable(now.now)).toBe(true)
  })
})
