import { getRequestCodeBlockedCountryPerIpLimits } from "@config"

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
