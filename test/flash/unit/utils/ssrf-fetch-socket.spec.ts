import dns from "dns"
import http from "http"
import { AddressInfo } from "net"

import { MAX_RESPONSE_BYTES, ssrfFetch, TOTAL_FETCH_TIMEOUT_MS } from "@utils/ssrf-guard"

import {
  clearDevUnsafeModeFlags,
  restoreDevUnsafeModeFlags,
} from "test/flash/helpers/dev-context-env"

// Socket-level spec: NOTHING here is mocked except DNS, so axios really opens
// a connection through the guarded agents. The other ssrf specs mock axios
// wholesale, which means they never exercise ssrfLookup's actual contract with
// net.connect — and that contract is where the guard can silently take the
// whole LNURL-pay route down (Node >= 20 calls the lookup with { all: true }
// and expects an array back; answering with a bare string fails every
// hostname connection with ERR_INVALID_IP_ADDRESS).

const savedNetwork = process.env.NETWORK

const setDevContext = (dev: boolean) => {
  if (dev) {
    process.env.NETWORK = "regtest"
  } else {
    process.env.NETWORK = "mainnet"
    clearDevUnsafeModeFlags()
  }
}

const restoreEnv = () => {
  if (savedNetwork === undefined) delete process.env.NETWORK
  else process.env.NETWORK = savedNetwork
  restoreDevUnsafeModeFlags()
}

describe("ssrfFetch over a real socket", () => {
  let server: http.Server
  let port: number
  let requestCount: number
  let handler: http.RequestListener

  let lookupSpy: jest.SpyInstance

  // Any timer a handler starts, so teardown can stop it even when the test it
  // belongs to failed before its own cleanup line ran.
  const openIntervals: NodeJS.Timeout[] = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requestCount += 1
      handler(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    // The trickle case below deliberately leaves a socket writing. If the
    // chain-abort guarantee ever regresses, that connection is still open here
    // and server.close() would hang the whole hook (and stop jest exiting) —
    // burying a red test under a CI timeout. Hang up on it explicitly.
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
    restoreEnv()
  })

  beforeEach(() => {
    requestCount = 0
    openIntervals.length = 0
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    }
    // The only mock: the hostname resolves to the loopback address the test
    // server actually listens on. Everything downstream is real.
    lookupSpy = jest
      .spyOn(dns.promises, "lookup")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as any)
  })

  afterEach(() => {
    for (const timer of openIntervals) clearInterval(timer)
    openIntervals.length = 0
    lookupSpy.mockRestore()
    restoreEnv()
  })

  it("completes a hostname fetch — the socket must accept what ssrfLookup returns", async () => {
    setDevContext(true)

    const resp = await ssrfFetch(new URL(`http://lnurl.test:${port}/pay`))

    expect(resp.status).toBe(200)
    expect(resp.data).toEqual({ ok: true })
    expect(requestCount).toBe(1)
    // Node >= 20's autoSelectFamily makes net.connect ask for every address.
    expect(lookupSpy).toHaveBeenCalledWith(
      "lnurl.test",
      expect.objectContaining({ all: true }),
    )
  })

  it("follows a redirect hop over real sockets", async () => {
    setDevContext(true)
    handler = (req, res) => {
      if (req.url === "/pay") {
        res.writeHead(302, { location: `http://lnurl.test:${port}/final` })
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ hopped: true }))
    }

    const resp = await ssrfFetch(new URL(`http://lnurl.test:${port}/pay`))

    expect(resp.data).toEqual({ hopped: true })
    expect(requestCount).toBe(2)
  })

  it("refuses at connect time when DNS rebinds to a private address", async () => {
    setDevContext(false)
    // A rebind: the pre-flight answer was public (checked by
    // validatePublicHttpUrl), the connect-time answer points at the metadata
    // service. The socket must never be opened.
    lookupSpy.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { address: "169.254.169.254", family: 4 } as any,
    ])

    await expect(ssrfFetch(new URL(`http://rebind.test:${port}/pay`))).rejects.toThrow(
      /connect-time DNS resolved to private address 169\.254\.169\.254/,
    )
    expect(requestCount).toBe(0)
  })

  it("refuses at connect time when only one of several answers is private", async () => {
    setDevContext(false)
    lookupSpy.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { address: "127.0.0.1", family: 4 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { address: "93.184.216.34", family: 4 } as any,
    ])

    await expect(ssrfFetch(new URL(`http://mixed.test:${port}/pay`))).rejects.toThrow(
      /connect-time DNS resolved to private address 127\.0\.0\.1/,
    )
    expect(requestCount).toBe(0)
  })

  it("caps the response body an attacker-chosen host can stream at us", async () => {
    setDevContext(true)
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" })
      const chunk = Buffer.alloc(16 * 1024, 0x61)
      // Well past MAX_RESPONSE_BYTES: without the cap axios buffers all of it.
      for (let i = 0; i < (MAX_RESPONSE_BYTES / chunk.length) * 4; i++) {
        res.write(chunk)
      }
      res.end()
    }

    await expect(ssrfFetch(new URL(`http://flood.test:${port}/pay`))).rejects.toThrow(
      /maxContentLength/i,
    )
  })

  // The slow-loris case the time budget exists for, and the one the mocked
  // specs cannot prove: they stub both axios and Date.now, so they pass whether
  // or not anything actually cuts a live socket. axios's `timeout` maps to
  // req.setTimeout(), a socket INACTIVITY timer that resets on every byte, and
  // the adapter's only wall-clock timer is cleared as soon as response headers
  // arrive. So a host that answers 200 immediately and then trickles a byte at
  // a time is never cut off by `timeout`, never reaches maxContentLength, and
  // holds a socket, an fd and a pending request open indefinitely — on a
  // public unauthenticated route, and under the sender's wallet redlock on
  // lnurlPaymentSend. Only the chain-wide AbortSignal ends it.
  it(
    "aborts a trickling host at the chain budget — `timeout` alone never fires",
    async () => {
      setDevContext(true)
      handler = (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" })
        // Well inside any inactivity timeout, so `timeout: remainingMs` keeps
        // being reset and never fires. Far too little data to trip the body cap.
        const trickle = setInterval(() => res.write("."), 250)
        openIntervals.push(trickle)
        res.on("close", () => clearInterval(trickle))
      }

      const startedAt = Date.now()
      const err = await ssrfFetch(new URL(`http://trickle.test:${port}/pay`)).catch(
        (e) => e,
      )
      const elapsed = Date.now() - startedAt

      expect(err).toBeInstanceOf(Error)
      // Whatever axios labels it, the guard must have ended it on the budget
      // rather than let it run — and it must not have taken materially longer.
      expect(elapsed).toBeGreaterThanOrEqual(TOTAL_FETCH_TIMEOUT_MS - 1_000)
      expect(elapsed).toBeLessThan(TOTAL_FETCH_TIMEOUT_MS + 5_000)
      expect(err.message).toMatch(/total fetch budget/)
    },
    TOTAL_FETCH_TIMEOUT_MS + 20_000,
  )
})
