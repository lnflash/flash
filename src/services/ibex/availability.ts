/**
 * Availability state for the IBEX rail.
 *
 * Every cash-wallet read in this app goes through IBEX, so a vendor blip used
 * to mean: each GraphQL request waits on its own fetch timeout and then
 * surfaces its own error — the wallet screen fails once per field. With a
 * breaker, the FIRST unanswered call opens the circuit and every later call in
 * the window takes the degraded path immediately (BTC reads from the mongo
 * ledger, cash reports an explicit unavailable state) instead of each paying
 * the timeout again. After the window the circuit is half-open: the next call
 * probes the rail and either closes the circuit or reopens it.
 *
 * The clock is injectable so the window is testable without timers.
 */
const IBEX_OPEN_WINDOW_MS = 3_000

let openedAt: number | undefined

export const isIbexAvailable = (now: () => number = Date.now): boolean => {
  if (openedAt === undefined) return true

  if (now() - openedAt >= IBEX_OPEN_WINDOW_MS) {
    // Half-open: forget the trip so the next call actually probes the rail.
    openedAt = undefined
    return true
  }

  return false
}

export const markIbexUnavailable = (now: () => number = Date.now): void => {
  openedAt = now()
}

export const resetIbexAvailability = (): void => {
  openedAt = undefined
}
