import {
  getGiftCardPurchaseAttemptLimits,
  getGiftCardQuoteAttemptLimits,
  getRequestCodeBlockedCountryPerIpLimits,
} from "@config"

import { RateLimitConfig, RateLimitPrefix } from "@domain/rate-limit"
import {
  GiftCardPurchaseRateLimiterExceededError,
  GiftCardQuoteRateLimiterExceededError,
} from "@domain/rate-limit/errors"

describe("getRequestCodeBlockedCountryPerIpLimits", () => {
  // Both numbers are load-bearing and neither comes from the yaml, so nothing
  // else in the suite pins them: the blocked-country spec mocks this getter,
  // and a revert of either value would otherwise leave the suite green.
  //
  // points: 5   — the bound on an account-existence sweep, which costs the
  //               attacker nothing because the gate rejects before any spend.
  //               Not lower: this bucket is keyed on the IP, so it is also
  //               spent by a real customer's mistyped digits and shared by
  //               everyone behind one office NAT or CGNAT egress. At 2 a UZ
  //               account holder who fat-fingers their number twice loses an
  //               hour of their own login codes with no attacker involved,
  //               and a sweep is equally dead at 5/IP/h.
  // blockDuration: 1h, NOT the 24h the other auth limiters use — the key is the
  //               `x-real-ip` header and a large share of Flash's users share a
  //               carrier-grade NAT egress address, so a 24h block would cost
  //               every real customer behind a probed address a full day of
  //               their own login codes.
  it("bounds the existence probe at 5/h and heals a shared-IP block in an hour", () => {
    expect(getRequestCodeBlockedCountryPerIpLimits()).toEqual({
      points: 5,
      duration: 3600,
      blockDuration: 3600,
    })
  })

  // The carve-out exists so a real account in a blocked country is never locked
  // out of its own login code. A budget at or below the number of typos a
  // person makes would defeat it without an attacker in the picture.
  it("leaves room for a real customer's mistyped digits and a shared egress IP", () => {
    expect(getRequestCodeBlockedCountryPerIpLimits().points).toBeGreaterThanOrEqual(5)
  })
})

describe("getGiftCardPurchaseAttemptLimits", () => {
  // Hardcoded in src/config/yaml.ts, not in the yaml, so nothing else pins it:
  // the purchase spec mocks the limiter and the error map does not care about
  // the numbers. Charged once per mutation, before any vendor or store call,
  // so it is the only thing that bounds a client looping on a refused request.
  //
  // points: 10/min — a customer retrying a timed-out call with the SAME key
  //               replays and does not spend a point (purchase-gift-card.ts),
  //               so 10 fresh attempts a minute is already far beyond honest
  //               use. Each fresh attempt is a live vendor quote + createOrder.
  // blockDuration: 5 min — long enough to stop a looping client, short enough
  //               that a customer who hit it can still buy the card they want.
  it("bounds fresh purchase attempts at 10/min with a 5 minute block", () => {
    expect(getGiftCardPurchaseAttemptLimits()).toEqual({
      points: 10,
      duration: 60,
      blockDuration: 300,
    })
  })

  it("is wired into RateLimitConfig under its own prefix and error, with those numbers", () => {
    expect(RateLimitConfig.giftCardPurchase).toEqual({
      key: "gift_card_purchase",
      limits: { points: 10, duration: 60, blockDuration: 300 },
      error: GiftCardPurchaseRateLimiterExceededError,
    })
    expect(RateLimitPrefix.giftCardPurchase).toBe("gift_card_purchase")
  })
})

describe("getGiftCardQuoteAttemptLimits", () => {
  // Hardcoded like the purchase budget beside it — not in the yaml — so nothing
  // else in the suite pins these; the app spec mocks the whole registry.
  //
  // points: 30/min — a confirm screen renders this and a customer adjusting a
  //               value or quantity can honestly ask several times a minute.
  //               Each call is a live vendor POST through the ONE shared
  //               reseller login, so the bound is what keeps a looping client
  //               from getting that login throttled for every customer.
  // blockDuration: 5 min, same as the purchase — a quote is good until its
  //               `expiresAt`, so a client told to back off loses nothing by
  //               reusing the last one.
  it("bounds quotes at 30/min with a 5 minute block", () => {
    expect(getGiftCardQuoteAttemptLimits()).toEqual({
      points: 30,
      duration: 60,
      blockDuration: 300,
    })
  })

  it("is looser than the purchase budget: pricing is cheaper than buying", () => {
    expect(getGiftCardQuoteAttemptLimits().points).toBeGreaterThan(
      getGiftCardPurchaseAttemptLimits().points,
    )
  })

  it("is wired into RateLimitConfig under its own prefix and error, apart from the purchase", () => {
    // Literal numbers, not the getter: a config that restates itself would
    // stay green if both sides drifted together.
    expect(RateLimitConfig.giftCardQuote).toEqual({
      key: "gift_card_quote",
      limits: { points: 30, duration: 60, blockDuration: 300 },
      error: GiftCardQuoteRateLimiterExceededError,
    })
    expect(RateLimitPrefix.giftCardQuote).toBe("gift_card_quote")
    // Its own bucket: spending the purchase budget must not silence the price.
    expect(RateLimitPrefix.giftCardQuote).not.toBe(RateLimitPrefix.giftCardPurchase)
    expect(RateLimitConfig.giftCardQuote.error).not.toBe(
      GiftCardPurchaseRateLimiterExceededError,
    )
  })
})
