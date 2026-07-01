import { toSeconds } from "@domain/primitives"

const SECS_PER_MIN = toSeconds(60)
const SECS_PER_5_MINS = toSeconds(60 * 5)
const SECS_PER_DAY = toSeconds(60 * 60 * 24)

export const defaultTimeToExpiryInSeconds = SECS_PER_5_MINS

// IBEX caps BOLT11 receive-invoice expiry by the account's currency type:
//   - msat currency accounts: up to 900s
//   - all other currency accounts (USD/USDT/JMD): up to 60s
// Flash does not use msat currency accounts for its IBEX receive flows, so
// every Flash IBEX receive invoice is limited to 60s. IBEX silently caps any
// larger requested expiration down to this value, so the backend must not
// request more than this. (Confirmed by IBEX 2026-06-18 — see ENG-427.)
export const IBEX_RECEIVE_MAX_EXPIRATION_SECONDS = SECS_PER_MIN

// Default receive-invoice expiry for Flash IBEX flows, expressed in minutes for
// the GraphQL `expiresIn` contract. Capped at the IBEX limit above.
export const ibexReceiveDefaultExpirationMinutes = (IBEX_RECEIVE_MAX_EXPIRATION_SECONDS /
  SECS_PER_MIN) as Minutes

// Clamp a requested IBEX receive-invoice expiration to the account-type limit.
// `undefined` is passed through so IBEX applies its own account default.
export const cappedIbexReceiveExpiration = (
  expiration?: Seconds,
): Seconds | undefined => {
  if (expiration === undefined) return undefined
  return (
    expiration > IBEX_RECEIVE_MAX_EXPIRATION_SECONDS
      ? IBEX_RECEIVE_MAX_EXPIRATION_SECONDS
      : expiration
  ) as Seconds
}

export const DEFAULT_EXPIRATIONS = {
  BTC: { delay: SECS_PER_DAY, delayMinutes: (SECS_PER_DAY / SECS_PER_MIN) as Minutes },
  USD: {
    delay: defaultTimeToExpiryInSeconds,
    delayMinutes: (defaultTimeToExpiryInSeconds / SECS_PER_MIN) as Minutes,
  },
  JMD: {
    delay: defaultTimeToExpiryInSeconds,
    delayMinutes: (defaultTimeToExpiryInSeconds / SECS_PER_MIN) as Minutes,
  },
  USDT: {
    delay: defaultTimeToExpiryInSeconds,
    delayMinutes: (defaultTimeToExpiryInSeconds / SECS_PER_MIN) as Minutes,
  },
}

export const invoiceExpirationForCurrency = (
  currency: WalletCurrency,
  now: Date,
  delay?: Seconds,
): InvoiceExpiration => {
  let expirationDelay = delay || toSeconds(0)
  const { delay: defaultDelay } = DEFAULT_EXPIRATIONS[currency]
  if (expirationDelay < SECS_PER_MIN || expirationDelay > defaultDelay) {
    expirationDelay = defaultDelay
  }

  const expirationTimestamp = now.getTime() + expirationDelay * 1000
  return new Date(expirationTimestamp) as InvoiceExpiration
}
