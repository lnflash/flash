import { SECS_PER_10_MINS, SECS_PER_DAY } from "@config"

import { toSeconds } from "@domain/primitives"
import { WalletCurrency } from "@domain/shared"
import {
  invoiceExpirationForCurrency,
  IBEX_RECEIVE_MAX_EXPIRATION_SECONDS,
  ibexReceiveDefaultExpirationMinutes,
  cappedIbexReceiveExpiration,
} from "@domain/bitcoin/lightning"

describe("invoiceExpirationForCurrency", () => {
  const BTC = WalletCurrency.Btc
  const USD = WalletCurrency.Usd
  const now = new Date("2000-01-01T00:00:00Z")

  it("should return expiration for BTC currency with default delay", () => {
    const expectedExpiration = new Date("2000-01-02T00:00:00.000Z")
    let expiresAt = invoiceExpirationForCurrency(BTC, now)
    expect(expiresAt).toEqual(expectedExpiration)

    let delay = toSeconds(59)
    expiresAt = invoiceExpirationForCurrency(BTC, now, delay)
    expect(expiresAt).toEqual(expectedExpiration)

    delay = toSeconds(0)
    expiresAt = invoiceExpirationForCurrency(BTC, now, delay)
    expect(expiresAt).toEqual(expectedExpiration)

    delay = toSeconds(2 * SECS_PER_DAY)
    expiresAt = invoiceExpirationForCurrency(BTC, now, delay)
    expect(expiresAt).toEqual(expectedExpiration)
  })

  it("should return expiration for USD currency with default delay", () => {
    const expectedExpiration = new Date("2000-01-01T00:05:00.000Z")
    let expiresAt = invoiceExpirationForCurrency(USD, now)
    expect(expiresAt).toEqual(expectedExpiration)

    let delay = toSeconds(59)
    expiresAt = invoiceExpirationForCurrency(USD, now, delay)
    expect(expiresAt).toEqual(expectedExpiration)

    delay = toSeconds(0)
    expiresAt = invoiceExpirationForCurrency(USD, now, delay)
    expect(expiresAt).toEqual(expectedExpiration)

    delay = toSeconds(SECS_PER_10_MINS)
    expiresAt = invoiceExpirationForCurrency(USD, now, delay)
    expect(expiresAt).toEqual(expectedExpiration)
  })

  it("should return expiration for BTC currency with provided delay", () => {
    const delay = toSeconds(30 * 60)
    const currency = BTC
    const expiration = invoiceExpirationForCurrency(currency, now, delay)
    const expectedExpiration = new Date("2000-01-01T00:30:00Z")
    expect(expiration).toEqual(expectedExpiration)
  })

  it("should return expiration for USD currency with provided delay", () => {
    const delay = toSeconds(3 * 60)
    const currency = USD
    const expiration = invoiceExpirationForCurrency(currency, now, delay)
    const expectedExpiration = new Date("2000-01-01T00:03:00Z")
    expect(expiration).toEqual(expectedExpiration)
  })
})

// ENG-427: Flash uses non-msat IBEX currency accounts for receive, which IBEX
// caps at a 60s BOLT11 expiry. These guard the backend from requesting more.
describe("IBEX receive-invoice expiration policy", () => {
  it("caps the receive-invoice limit at 60 seconds", () => {
    expect(IBEX_RECEIVE_MAX_EXPIRATION_SECONDS).toEqual(60)
  })

  it("uses a default of 1 minute so the requested expiration is exactly 60s", () => {
    // The GraphQL `expiresIn` contract is in minutes and is multiplied by 60
    // before reaching IBEX. A 1-minute default keeps the request at 60s and
    // prevents the previous 5-minute (300s) default from being requested again.
    expect(ibexReceiveDefaultExpirationMinutes).toEqual(1)
    expect(ibexReceiveDefaultExpirationMinutes * 60).toEqual(
      IBEX_RECEIVE_MAX_EXPIRATION_SECONDS,
    )
  })

  describe("cappedIbexReceiveExpiration", () => {
    it("passes undefined through so IBEX applies its account default", () => {
      expect(cappedIbexReceiveExpiration(undefined)).toBeUndefined()
    })

    it("leaves an expiration at or below the cap unchanged", () => {
      expect(cappedIbexReceiveExpiration(toSeconds(60))).toEqual(60)
      expect(cappedIbexReceiveExpiration(toSeconds(30))).toEqual(30)
    })

    it("clamps a 5-minute (300s) request down to 60s", () => {
      expect(cappedIbexReceiveExpiration(toSeconds(300))).toEqual(60)
    })

    it("clamps the msat-account max (900s) down to 60s for Flash accounts", () => {
      expect(cappedIbexReceiveExpiration(toSeconds(900))).toEqual(60)
    })
  })
})
