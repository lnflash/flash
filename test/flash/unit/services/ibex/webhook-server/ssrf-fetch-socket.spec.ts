import dns from "dns"
import http from "http"
import { AddressInfo } from "net"

import { MAX_RESPONSE_BYTES, ssrfFetch } from "@services/ibex/webhook-server/ssrf-guard"

// Socket-level spec: NOTHING here is mocked except DNS, so axios really opens
// a connection through the guarded agents. The other ssrf specs mock axios
// wholesale, which means they never exercise ssrfLookup's actual contract with
// net.connect — and that contract is where the guard can silently take the
// whole LNURL-pay route down (Node >= 20 calls the lookup with { all: true }
// and expects an array back; answering with a bare string fails every
// hostname connection with ERR_INVALID_IP_ADDRESS).

const savedNetwork = process.env.NETWORK
const savedAllowDevSecrets = process.env.ALLOW_REPO_DEV_SECRETS

const setDevContext = (dev: boolean) => {
  if (dev) {
    process.env.NETWORK = "regtest"
  } else {
    process.env.NETWORK = "mainnet"
    delete process.env.ALLOW_REPO_DEV_SECRETS
  }
}

const restoreEnv = () => {
  if (savedNetwork === undefined) delete process.env.NETWORK
  else process.env.NETWORK = savedNetwork
  if (savedAllowDevSecrets === undefined) delete process.env.ALLOW_REPO_DEV_SECRETS
  else process.env.ALLOW_REPO_DEV_SECRETS = savedAllowDevSecrets
}

describe("ssrfFetch over a real socket", () => {
  let server: http.Server
  let port: number
  let requestCount: number
  let handler: http.RequestListener

  let lookupSpy: jest.SpyInstance

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requestCount += 1
      handler(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
    restoreEnv()
  })

  beforeEach(() => {
    requestCount = 0
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
})
