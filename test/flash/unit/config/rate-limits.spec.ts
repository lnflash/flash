import { getRequestCodeBlockedCountryPerIpLimits } from "@config"

describe("getRequestCodeBlockedCountryPerIpLimits", () => {
  // Both numbers are load-bearing and neither comes from the yaml, so nothing
  // else in the suite pins them: the blocked-country spec mocks this getter,
  // and a revert of either value would otherwise leave the suite green.
  //
  // points: 2   — the bound on an account-existence sweep, which costs the
  //               attacker nothing because the gate rejects before any spend.
  // blockDuration: 1h, NOT the 24h the other auth limiters use — the key is the
  //               `x-real-ip` header and a large share of Flash's users share a
  //               carrier-grade NAT egress address, so a 24h block would cost
  //               every real customer behind a probed address a full day of
  //               their own login codes.
  it("bounds the existence probe at 2/h and heals a shared-IP block in an hour", () => {
    expect(getRequestCodeBlockedCountryPerIpLimits()).toEqual({
      points: 2,
      duration: 3600,
      blockDuration: 3600,
    })
  })
})
