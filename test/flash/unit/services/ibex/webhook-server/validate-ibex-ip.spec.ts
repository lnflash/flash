import {
  parseAllowlist,
  isIpInAllowlist,
} from "@services/ibex/webhook-server/middleware/validate-ibex-ip"

describe("Ibex webhook IP allowlist (ISL-112)", () => {
  describe("parseAllowlist", () => {
    it("parses single IPs and CIDR ranges, ignoring blanks and invalid entries", () => {
      const ranges = parseAllowlist([
        "203.0.113.4",
        "198.51.100.0/24",
        "  ",
        "not-an-ip",
        "2001:db8::/32",
      ])
      // 203.0.113.4, 198.51.100.0/24, 2001:db8::/32 — the blank and "not-an-ip" dropped
      expect(ranges).toHaveLength(3)
    })
  })

  describe("isIpInAllowlist", () => {
    const ranges = parseAllowlist([
      "203.0.113.4",
      "198.51.100.0/24",
      "2001:db8::/32",
    ])

    it("matches an exact IPv4 address", () => {
      expect(isIpInAllowlist("203.0.113.4", ranges)).toBe(true)
    })

    it("rejects an IPv4 address that is not listed", () => {
      expect(isIpInAllowlist("203.0.113.5", ranges)).toBe(false)
    })

    it("matches an IPv4 address inside a CIDR range", () => {
      expect(isIpInAllowlist("198.51.100.200", ranges)).toBe(true)
    })

    it("rejects an IPv4 address outside the CIDR range", () => {
      expect(isIpInAllowlist("198.51.101.1", ranges)).toBe(false)
    })

    it("normalizes IPv4-mapped IPv6 and matches the IPv4 range", () => {
      expect(isIpInAllowlist("::ffff:203.0.113.4", ranges)).toBe(true)
    })

    it("matches an IPv6 address inside a CIDR range", () => {
      expect(isIpInAllowlist("2001:db8::1", ranges)).toBe(true)
    })

    it("rejects an IPv6 address outside the range", () => {
      expect(isIpInAllowlist("2001:dead::1", ranges)).toBe(false)
    })

    it("returns false for missing or invalid client IPs", () => {
      expect(isIpInAllowlist(null, ranges)).toBe(false)
      expect(isIpInAllowlist(undefined, ranges)).toBe(false)
      expect(isIpInAllowlist("garbage", ranges)).toBe(false)
    })

    it("returns false when the allowlist is empty", () => {
      expect(isIpInAllowlist("203.0.113.4", [])).toBe(false)
    })
  })
})
