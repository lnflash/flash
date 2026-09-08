jest.mock("dns", () => ({
  promises: { lookup: jest.fn() },
}))
jest.mock("axios", () => ({
  __esModule: true,
  default: { get: jest.fn() },
}))

import dns from "dns"
import http from "http"
import https from "https"

import axios from "axios"

import {
  isPrivateIpLiteral,
  isSsrfBlockedError,
  MAX_REDIRECT_HOPS,
  MAX_RESPONSE_BYTES,
  SsrfBlockedUrlError,
  ssrfFetch,
  ssrfLookup,
  TOTAL_FETCH_TIMEOUT_MS,
  validatePublicHttpUrl,
} from "@services/ibex/webhook-server/ssrf-guard"
import { DEPRECATED_DEV_UNSAFE_MODE_FLAG, DEV_UNSAFE_MODE_FLAG } from "@utils/dev-context"

import {
  clearDevUnsafeModeFlags,
  restoreDevUnsafeModeFlags,
} from "test/flash/helpers/dev-context-env"

const lookup = dns.promises.lookup as jest.Mock
const axiosGet = axios.get as jest.Mock

const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }]

// The dev escape hatch is NETWORK=regtest OR FLASH_DEV_UNSAFE_MODE=true, and
// the repo's .env (which `make unit-in-ci` sources) sets the latter — so a
// "mainnet" case has to clear it explicitly or it is testing dev behaviour.
const setNetwork = (network?: string) => {
  if (network === undefined) {
    delete process.env.NETWORK
  } else {
    process.env.NETWORK = network
  }
  if (network !== "regtest") clearDevUnsafeModeFlags()
}

const restoreDevSecretsFlag = restoreDevUnsafeModeFlags

describe("validatePublicHttpUrl", () => {
  const savedNetwork = process.env.NETWORK

  beforeEach(() => {
    jest.clearAllMocks()
    setNetwork("mainnet")
    lookup.mockResolvedValue(PUBLIC_ADDR)
  })

  afterAll(() => {
    setNetwork(savedNetwork)
    restoreDevSecretsFlag()
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

  it("rejects unparsable URLs", async () => {
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

  it("rejects NAT64/6to4/teredo literals that smuggle a private v4 address", async () => {
    for (const host of [
      "[64:ff9b::a9fe:a9fe]", // RFC 6052 NAT64 of 169.254.169.254
      "[64:ff9b::7f00:1]", // NAT64 of 127.0.0.1
      "[2002:7f00:1::]", // 6to4 of 127.0.0.1
      "[2001::1]", // teredo
      "[::ffff:93.184.216.34]", // v4-mapped, even with a public payload
    ]) {
      const result = await validatePublicHttpUrl(`https://${host}/`)
      expect(result).toBeInstanceOf(SsrfBlockedUrlError)
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it("rejects a hostname whose DNS answer is a NAT64 address", async () => {
    // What a DNS64 resolver hands back on an IPv6-only node pool for a host
    // whose A record is the metadata service.
    lookup.mockResolvedValue([{ address: "64:ff9b::a9fe:a9fe", family: 6 }])
    expect(await validatePublicHttpUrl("https://dns64.example.com/")).toBeInstanceOf(
      SsrfBlockedUrlError,
    )
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

  // The repo's own dev stack runs NETWORK=mainnet against the Ibex sandbox, so
  // the SSRF guard has to read the same dev-context predicate the weak-secret
  // guard does or a developer with a localhost lnurlp gets a 502.
  describe("FLASH_DEV_UNSAFE_MODE (local dev stack on mainnet)", () => {
    beforeEach(() => {
      setNetwork("mainnet")
      process.env[DEV_UNSAFE_MODE_FLAG] = "true"
    })

    afterEach(clearDevUnsafeModeFlags)

    it("allows http and loopback the way regtest does", async () => {
      expect(
        await validatePublicHttpUrl("http://localhost:3000/lnurl"),
      ).not.toBeInstanceOf(Error)
      expect(
        await validatePublicHttpUrl("http://127.0.0.1:3000/lnurl"),
      ).not.toBeInstanceOf(Error)
    })

    // The rename kept the old spelling working for one release; an install
    // still carrying it in its .env must not silently lose the escape hatch.
    it("honours the deprecated ALLOW_REPO_DEV_SECRETS spelling too", async () => {
      clearDevUnsafeModeFlags()
      process.env[DEPRECATED_DEV_UNSAFE_MODE_FLAG] = "true"
      expect(
        await validatePublicHttpUrl("http://localhost:3000/lnurl"),
      ).not.toBeInstanceOf(Error)
    })

    it("is off without the flag — the same URLs are blocked", async () => {
      clearDevUnsafeModeFlags()
      expect(await validatePublicHttpUrl("http://localhost:3000/lnurl")).toBeInstanceOf(
        SsrfBlockedUrlError,
      )
      expect(await validatePublicHttpUrl("https://127.0.0.1:3000/lnurl")).toBeInstanceOf(
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

// The agents axios uses are mocked away in every route-level spec, so this
// closure — the connect-time half of the TOCTOU fix — is exercised directly
// here. The socket-level contract (what net.connect actually passes and
// expects back) is covered in ssrf-fetch-socket.spec.ts, which opens a real
// connection instead of mocking axios.
describe("ssrfLookup — connect-time DNS validation", () => {
  const savedNetwork = process.env.NETWORK

  const callLookupWith = (
    hostname: string,
    options: dns.LookupOptions,
  ): Promise<{
    err: Error | null
    address: string | dns.LookupAddress[]
    family?: number
  }> =>
    new Promise((resolve) => {
      ssrfLookup(hostname, options, (err, address, family) =>
        resolve({ err: err as Error | null, address, family }),
      )
    })

  // The single-address form (autoSelectFamily off / explicit family).
  const callLookup = async (
    hostname: string,
  ): Promise<{ err: Error | null; address: string; family: number }> => {
    const { err, address, family } = await callLookupWith(hostname, {})
    return { err, address: address as string, family: family as number }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    setNetwork("mainnet")
  })

  afterAll(() => {
    setNetwork(savedNetwork)
    restoreDevSecretsFlag()
  })

  it("errors when ANY resolved address is private — the public ones don't save it", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ])

    const { err } = await callLookup("rebind.example.com")

    expect(err).toBeInstanceOf(SsrfBlockedUrlError)
    expect((err as Error).message).toContain("169.254.169.254")
  })

  it("errors when the only resolved address is private", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.8", family: 4 }])

    const { err } = await callLookup("internal.example.com")

    expect(err).toBeInstanceOf(SsrfBlockedUrlError)
  })

  it("resolves with the first address when every address is public", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ])

    const { err, address, family } = await callLookup("pay.example.com")

    expect(err).toBeNull()
    expect(address).toBe("93.184.216.34")
    expect(family).toBe(4)
    expect(lookup).toHaveBeenCalledWith("pay.example.com", {
      all: true,
      verbatim: true,
    })
  })

  // Node >= 20 defaults autoSelectFamily to true, so this is the form the
  // socket layer actually uses. Calling back with a bare string here makes
  // every hostname connection fail with ERR_INVALID_IP_ADDRESS.
  it("answers the all:true form with the full address array", async () => {
    const addresses = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]
    lookup.mockResolvedValue(addresses)

    const { err, address } = await callLookupWith("pay.example.com", { all: true })

    expect(err).toBeNull()
    expect(address).toEqual(addresses)
  })

  it("forwards the socket's family/hints to the resolver", async () => {
    lookup.mockResolvedValue(PUBLIC_ADDR)

    await callLookupWith("pay.example.com", { all: true, family: 4, hints: 1024 })

    expect(lookup).toHaveBeenCalledWith("pay.example.com", {
      all: true,
      verbatim: true,
      family: 4,
      hints: 1024,
    })
  })

  it("errors when DNS returns no addresses", async () => {
    lookup.mockResolvedValue([])

    const { err } = await callLookup("empty.example.com")

    expect(err).toBeInstanceOf(SsrfBlockedUrlError)
  })

  it("passes DNS failures through as errors", async () => {
    const dnsError = new Error("ENOTFOUND")
    lookup.mockRejectedValue(dnsError)

    const { err } = await callLookup("gone.example.com")

    expect(err).toBe(dnsError)
  })

  it("lets private addresses through on regtest (dev network)", async () => {
    setNetwork("regtest")
    lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }])

    const { err, address, family } = await callLookup("localhost")

    expect(err).toBeNull()
    expect(address).toBe("10.0.0.5")
    expect(family).toBe(4)
  })
})

describe("ssrfFetch — guard wiring", () => {
  const savedNetwork = process.env.NETWORK
  const URL_PUBLIC = new URL("https://pay.example.com/lnurl")

  const lastAxiosConfig = () => axiosGet.mock.calls[axiosGet.mock.calls.length - 1][1]

  beforeEach(() => {
    jest.clearAllMocks()
    setNetwork("mainnet")
    lookup.mockResolvedValue(PUBLIC_ADDR)
    axiosGet.mockResolvedValue({ status: 200, headers: {}, data: {} })
  })

  afterAll(() => {
    setNetwork(savedNetwork)
    restoreDevSecretsFlag()
  })

  it("sends the connect-time-validating agents with redirects disabled", async () => {
    await ssrfFetch(URL_PUBLIC)

    const config = lastAxiosConfig()
    expect(config.httpAgent).toBeInstanceOf(http.Agent)
    expect(config.httpsAgent).toBeInstanceOf(https.Agent)
    // The agents must be the ones wired to ssrfLookup, not fresh defaults —
    // dropping ...ssrfAgents from the request config fails here.
    expect(config.httpAgent.options.lookup).toBe(ssrfLookup)
    expect(config.httpsAgent.options.lookup).toBe(ssrfLookup)
    expect(config.maxRedirects).toBe(0)
    // An attacker-chosen host must not be able to stream us out of memory.
    expect(config.maxContentLength).toBe(MAX_RESPONSE_BYTES)
    expect(config.maxBodyLength).toBe(MAX_RESPONSE_BYTES)
    // 3xx passes through (manual re-validation), 4xx does not.
    expect(config.validateStatus(302)).toBe(true)
    expect(config.validateStatus(404)).toBe(false)
  })

  it("cannot be bypassed by caller-supplied agents, maxRedirects, validateStatus, or timeout", async () => {
    await ssrfFetch(URL_PUBLIC, {
      httpAgent: new http.Agent(),
      httpsAgent: new https.Agent(),
      maxRedirects: 5,
      timeout: 1,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    })

    const config = lastAxiosConfig()
    expect(config.httpAgent.options.lookup).toBe(ssrfLookup)
    expect(config.httpsAgent.options.lookup).toBe(ssrfLookup)
    expect(config.maxRedirects).toBe(0)
    // The caller's 1ms is ignored; the first hop gets (almost) the whole
    // budget, and never more than it.
    expect(config.timeout).toBeGreaterThan(1)
    expect(config.timeout).toBeLessThanOrEqual(TOTAL_FETCH_TIMEOUT_MS)
    expect(config.maxContentLength).toBe(MAX_RESPONSE_BYTES)
    expect(config.maxBodyLength).toBe(MAX_RESPONSE_BYTES)
    expect(config.validateStatus(404)).toBe(false)
  })

  it("still passes caller params and headers through", async () => {
    await ssrfFetch(URL_PUBLIC, {
      params: { amount: 1000 },
      headers: { "x-custom": "yes" },
    })

    const config = lastAxiosConfig()
    expect(config.params).toEqual({ amount: 1000 })
    expect(config.headers).toEqual({ "x-custom": "yes" })
  })

  // Redirect targets on this route are attacker-chosen twice over: the wallet
  // owner picks the lnurlp host, and that host picks the Location. This loop
  // replaced follow-redirects, which strips Authorization/Cookie on a
  // cross-host redirect — so it has to do the same, or the next caller to add
  // an API-key header hands it to wherever a user's lnurlp points.
  describe("credentials across redirects", () => {
    const CALLER_CONFIG = {
      params: { amount: 1000 },
      headers: { authorization: "Bearer caller-credential" },
    }

    const configOfCall = (index: number) => axiosGet.mock.calls[index][1]

    it("drops caller headers and params on a cross-origin redirect", async () => {
      axiosGet
        .mockResolvedValueOnce({
          status: 302,
          headers: { location: "https://someone-elses-host.example.net/next" },
          data: {},
        })
        .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } })

      await ssrfFetch(URL_PUBLIC, CALLER_CONFIG)

      expect(axiosGet).toHaveBeenCalledTimes(2)
      // The first hop is the host the caller chose to talk to, so it keeps them.
      expect(configOfCall(0).headers).toEqual(CALLER_CONFIG.headers)
      expect(configOfCall(0).params).toEqual(CALLER_CONFIG.params)
      expect(configOfCall(1).headers).toBeUndefined()
      expect(configOfCall(1).params).toBeUndefined()
    })

    it("keeps them on a same-origin redirect", async () => {
      axiosGet
        .mockResolvedValueOnce({
          status: 302,
          headers: { location: "https://pay.example.com/hop1" },
          data: {},
        })
        .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } })

      await ssrfFetch(URL_PUBLIC, CALLER_CONFIG)

      expect(configOfCall(1).headers).toEqual(CALLER_CONFIG.headers)
      expect(configOfCall(1).params).toEqual(CALLER_CONFIG.params)
    })

    // Once dropped, they stay dropped: a chain that bounces off-origin and
    // back must not hand the credential to the origin's second hop either.
    it("does not restore them on a later hop", async () => {
      axiosGet
        .mockResolvedValueOnce({
          status: 302,
          headers: { location: "https://someone-elses-host.example.net/a" },
          data: {},
        })
        .mockResolvedValueOnce({
          status: 302,
          headers: { location: "https://someone-elses-host.example.net/b" },
          data: {},
        })
        .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } })

      await ssrfFetch(URL_PUBLIC, CALLER_CONFIG)

      expect(axiosGet).toHaveBeenCalledTimes(3)
      expect(configOfCall(2).headers).toBeUndefined()
      expect(configOfCall(2).params).toBeUndefined()
    })

    // A cross-origin hop must not cost the guard's own fields.
    it("keeps the guard fields on the post-redirect hop", async () => {
      axiosGet
        .mockResolvedValueOnce({
          status: 302,
          headers: { location: "https://someone-elses-host.example.net/next" },
          data: {},
        })
        .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } })

      await ssrfFetch(URL_PUBLIC, CALLER_CONFIG)

      const config = configOfCall(1)
      expect(config.httpAgent.options.lookup).toBe(ssrfLookup)
      expect(config.httpsAgent.options.lookup).toBe(ssrfLookup)
      expect(config.maxRedirects).toBe(0)
      expect(config.maxContentLength).toBe(MAX_RESPONSE_BYTES)
    })
  })

  it(`throws SsrfBlockedUrlError after ${MAX_REDIRECT_HOPS} redirect hops`, async () => {
    axiosGet.mockResolvedValue({
      status: 302,
      headers: { location: "https://cdn.example.com/next" },
      data: {},
    })

    await expect(ssrfFetch(URL_PUBLIC)).rejects.toBeInstanceOf(SsrfBlockedUrlError)
    // hop 0..MAX_REDIRECT_HOPS fetches happen before the limit check trips.
    expect(axiosGet).toHaveBeenCalledTimes(MAX_REDIRECT_HOPS + 1)
  })

  it("returns the response when a redirect chain stays within the hop limit", async () => {
    axiosGet
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: "https://cdn.example.com/hop1" },
        data: {},
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } })

    const resp = await ssrfFetch(URL_PUBLIC)

    expect(resp.data).toEqual({ ok: true })
    expect(axiosGet).toHaveBeenCalledTimes(2)
  })

  describe("total time budget", () => {
    // Deterministic clock the fetch mock advances, so each "hop" burns a known
    // slice of the budget. With a per-hop timeout every hop would get the full
    // 10s and a 3-hop chain could hold a request (and an API worker) for 4x
    // the number in the config.
    let now = 1_000_000

    const hopTakes = (ms: number, response: unknown) =>
      axiosGet.mockImplementation(async () => {
        now += ms
        return response
      })

    beforeEach(() => {
      now = 1_000_000
      jest.spyOn(Date, "now").mockImplementation(() => now)
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it("shrinks the per-hop timeout as the chain burns the budget", async () => {
      const redirect = {
        status: 302,
        headers: { location: "https://cdn.example.com/hop1" },
        data: {},
      }
      const ok = { status: 200, headers: {}, data: { ok: true } }
      let call = 0
      axiosGet.mockImplementation(async () => {
        now += 4_000
        call += 1
        return call === 1 ? redirect : ok
      })

      await ssrfFetch(URL_PUBLIC)

      const timeouts = axiosGet.mock.calls.map((c) => c[1].timeout)
      expect(timeouts).toEqual([TOTAL_FETCH_TIMEOUT_MS, TOTAL_FETCH_TIMEOUT_MS - 4_000])
    })

    it("aborts the chain once the budget is spent", async () => {
      hopTakes(TOTAL_FETCH_TIMEOUT_MS, {
        status: 302,
        headers: { location: "https://cdn.example.com/next" },
        data: {},
      })

      const err = await ssrfFetch(URL_PUBLIC).catch((e) => e)

      expect(err).toBeInstanceOf(SsrfBlockedUrlError)
      expect(err.message).toMatch(/total fetch budget/)
      // The hop limit was never reached — time ran out first, after one hop.
      expect(axiosGet).toHaveBeenCalledTimes(1)
    })
  })
})

describe("isSsrfBlockedError", () => {
  it("sees through the AxiosError a connect-time refusal is wrapped in", () => {
    const blocked = new SsrfBlockedUrlError("rebind.example.com", "private address")
    const wrapped = Object.assign(new Error("connect ECONNREFUSED"), { cause: blocked })

    expect(isSsrfBlockedError(blocked)).toBe(true)
    expect(isSsrfBlockedError(wrapped)).toBe(true)
    expect(isSsrfBlockedError(new Error("socket hang up"))).toBe(false)
    expect(isSsrfBlockedError("nope")).toBe(false)
  })

  it("terminates on a self-referencing cause chain", () => {
    const looped: Error & { cause?: unknown } = new Error("loop")
    looped.cause = looped

    expect(isSsrfBlockedError(looped)).toBe(false)
  })
})
