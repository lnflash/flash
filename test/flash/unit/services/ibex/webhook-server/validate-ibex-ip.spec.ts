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
    const ranges = parseAllowlist(["203.0.113.4", "198.51.100.0/24", "2001:db8::/32"])

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

describe("validateIbexHubIp (ENG-891)", () => {
  type Middleware =
    typeof import("@services/ibex/webhook-server/middleware/validate-ibex-ip")

  // The module parses both allowlists when it loads, so each config gets a
  // fresh copy of it.
  const loadWithConfig = (allowedIps: string[], hubAllowedIps: string[]): Middleware => {
    let loaded: Middleware | undefined
    jest.isolateModules(() => {
      jest.doMock("@config", () => ({
        IbexConfig: {
          webhook: { allowedIps, hub: { allowedIps: hubAllowedIps } },
        },
      }))
      jest.doMock("@services/logger", () => ({
        baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      }))
      loaded = jest.requireActual<Middleware>(
        "@services/ibex/webhook-server/middleware/validate-ibex-ip",
      )
    })
    return loaded as Middleware
  }

  const call = (middleware: Middleware["validateIbexHubIp"], ip: string) => {
    const end = jest.fn()
    const status = jest.fn(() => ({ end }))
    const next = jest.fn()
    const req = { ip, path: "/hub/transactions", socket: {} } as unknown as Parameters<
      Middleware["validateIbexHubIp"]
    >[0]
    const resp = { status } as unknown as Parameters<Middleware["validateIbexHubIp"]>[1]
    middleware(req, resp, next)
    return { status, end, next }
  }

  afterEach(() => {
    jest.dontMock("@config")
    jest.dontMock("@services/logger")
  })

  it("passes a sender on the hub list", () => {
    const { validateIbexHubIp } = loadWithConfig(["198.51.100.9"], ["203.0.113.4"])
    const { status, next } = call(validateIbexHubIp, "203.0.113.4")
    expect(next).toHaveBeenCalledTimes(1)
    expect(status).not.toHaveBeenCalled()
  })

  it("answers 403 to a sender on the legacy list but not the hub list", () => {
    const { validateIbexHubIp } = loadWithConfig(["198.51.100.9"], ["203.0.113.4"])
    const { status, end, next } = call(validateIbexHubIp, "198.51.100.9")
    expect(status).toHaveBeenCalledWith(403)
    expect(end).toHaveBeenCalledWith("Forbidden")
    expect(next).not.toHaveBeenCalled()
  })

  it("answers 403 to a sender on neither list", () => {
    const { validateIbexHubIp } = loadWithConfig(["198.51.100.9"], ["203.0.113.4"])
    const { status, next } = call(validateIbexHubIp, "192.0.2.1")
    expect(status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it("passes any sender when the hub list is empty, even with a legacy list set", () => {
    const { validateIbexHubIp } = loadWithConfig(["198.51.100.9"], [])
    const { status, next } = call(validateIbexHubIp, "192.0.2.1")
    expect(next).toHaveBeenCalledTimes(1)
    expect(status).not.toHaveBeenCalled()
  })

  it("leaves the legacy gate on the legacy list only", () => {
    const { validateIbexIp } = loadWithConfig(["198.51.100.9"], ["203.0.113.4"])
    expect(call(validateIbexIp, "198.51.100.9").next).toHaveBeenCalledTimes(1)
    expect(call(validateIbexIp, "203.0.113.4").status).toHaveBeenCalledWith(403)
  })
})
