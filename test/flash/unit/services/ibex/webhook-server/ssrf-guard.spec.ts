jest.mock("dns", () => ({
  promises: { lookup: jest.fn() },
}))

import dns from "dns"

import {
  isPrivateIpLiteral,
  SsrfBlockedUrlError,
  validatePublicHttpUrl,
} from "@services/ibex/webhook-server/ssrf-guard"

const lookup = dns.promises.lookup as jest.Mock

const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }]

const setNetwork = (network?: string) => {
  if (network === undefined) {
    delete process.env.NETWORK
  } else {
    process.env.NETWORK = network
  }
}

describe("validatePublicHttpUrl", () => {
  const savedNetwork = process.env.NETWORK

  beforeEach(() => {
    jest.clearAllMocks()
    setNetwork("mainnet")
    lookup.mockResolvedValue(PUBLIC_ADDR)
  })

  afterAll(() => {
    setNetwork(savedNetwork)
  })

  it("accepts an https URL on a public host", async () => {
    const result = await validatePublicHttpUrl("https://pay.example.com/lnurl")
    expect(result).not.toBeInstanceOf(Error)
    expect((result as URL).toString()).toBe("https://pay.example.com/lnurl")
    expect(lookup).toHaveBeenCalledWith("pay.example.com", {
      all: true,
      verbatim: true,
    })
  })

  it("rejects non-https schemes", async () => {
    for (const url of [
      "http://pay.example.com/lnurl",
      "ftp://pay.example.com/",
      "file:///etc/passwd",
      "gopher://internal/",
    ]) {
      const result = await validatePublicHttpUrl(url)
      expect(result).toBeInstanceOf(SsrfBlockedUrlError)
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it("rejects unparseable URLs", async () => {
    for (const url of ["", "not-a-url", "https://"]) {
      expect(await validatePublicHttpUrl(url)).toBeInstanceOf(SsrfBlockedUrlError)
    }
  })

  it("rejects private/loopback/link-local IPv4 literals without a DNS lookup", async () => {
    for (const host of [
      "169.254.169.254", // cloud metadata
      "169.254.1.1",
      "127.0.0.1",
      "127.53.0.9",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "0.0.0.0",
      "100.64.0.1", // CGNAT
      "224.0.0.1", // multicast
    ]) {
      const result = await validatePublicHttpUrl(`https://${host}/`)
      expect(result).toBeInstanceOf(SsrfBlockedUrlError)
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it("does not over-block adjacent public ranges", async () => {
    for (const host of ["172.15.0.1", "172.32.0.1", "192.167.1.1", "11.0.0.1"]) {
      const result = await validatePublicHttpUrl(`https://${host}/`)
      expect(result).not.toBeInstanceOf(Error)
    }
    // IP literals skip DNS
    expect(lookup).not.toHaveBeenCalled()
  })

  it("rejects IPv6 loopback, link-local, unique-local and mapped-private literals", async () => {
    for (const host of [
      "[::1]",
      "[::]",
      "[fe80::1]",
      "[fc00::1]",
      "[fd00::abcd]",
      "[ff02::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:169.254.169.254]",
      "[::ffff:10.1.2.3]",
    ]) {
      const result = await validatePublicHttpUrl(`https://${host}/`)
      expect(result).toBeInstanceOf(SsrfBlockedUrlError)
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it("rejects well-known metadata hostnames", async () => {
    for (const host of ["metadata.google.internal", "localhost", "api.localhost"]) {
      expect(await validatePublicHttpUrl(`https://${host}/`)).toBeInstanceOf(
        SsrfBlockedUrlError,
      )
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it("rejects a public hostname that resolves to a private address", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.8", family: 4 }])
    const result = await validatePublicHttpUrl("https://rebind.example.com/")
    expect(result).toBeInstanceOf(SsrfBlockedUrlError)
  })

  it("rejects when ANY resolved address is private", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ])
    const result = await validatePublicHttpUrl("https://mixed.example.com/")
    expect(result).toBeInstanceOf(SsrfBlockedUrlError)
  })

  it("rejects a hostname that resolves to a private IPv6 address", async () => {
    lookup.mockResolvedValue([{ address: "fd00::1", family: 6 }])
    const result = await validatePublicHttpUrl("https://v6only.example.com/")
    expect(result).toBeInstanceOf(SsrfBlockedUrlError)
  })

  it("rejects when DNS fails or returns nothing", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"))
    expect(await validatePublicHttpUrl("https://gone.example.com/")).toBeInstanceOf(
      SsrfBlockedUrlError,
    )

    lookup.mockResolvedValue([])
    expect(await validatePublicHttpUrl("https://gone.example.com/")).toBeInstanceOf(
      SsrfBlockedUrlError,
    )
  })

  it("rejects hex/decimal IPv4 obfuscation after URL normalization", async () => {
    // WHATWG URL normalizes these to 127.0.0.1 before we ever see them.
    for (const url of ["https://0x7f000001/", "https://2130706433/", "https://127.1/"]) {
      expect(await validatePublicHttpUrl(url)).toBeInstanceOf(SsrfBlockedUrlError)
    }
  })

  describe("regtest (dev network)", () => {
    beforeEach(() => {
      setNetwork("regtest")
    })

    it("allows http and loopback so local lnurl servers keep working", async () => {
      const result = await validatePublicHttpUrl("http://localhost:3000/lnurl")
      expect(result).not.toBeInstanceOf(Error)

      const literal = await validatePublicHttpUrl("http://127.0.0.1:3000/lnurl")
      expect(literal).not.toBeInstanceOf(Error)
    })

    it("still rejects non-http schemes", async () => {
      expect(await validatePublicHttpUrl("file:///etc/passwd")).toBeInstanceOf(
        SsrfBlockedUrlError,
      )
    })
  })
})

describe("isPrivateIpLiteral", () => {
  it("handles bracketed and bare IPv6", () => {
    expect(isPrivateIpLiteral("[::1]")).toBe(true)
    expect(isPrivateIpLiteral("::1")).toBe(true)
    expect(isPrivateIpLiteral("[2606:4700:4700::1111]")).toBe(false)
  })
})
