jest.mock("@config", () => ({
  BridgeConfig: {
    apiKey: "test-api-key",
    baseUrl: "https://api.sandbox.bridge.xyz/v0",
  },
}))
jest.mock("@services/alerts", () => ({
  alertBridge: jest.fn(),
  generateDedupKey: {
    bridgeApi5xx: jest.fn(),
    bridgeApiTimeout: jest.fn(),
    bridgeApiNetwork: jest.fn(),
  },
}))

import { createServer, Server } from "node:http"

import { BridgeClient } from "@services/bridge/client"
import { toBridgeCustomerId } from "@domain/primitives/bridge"

describe("owned existing-customer hosted links", () => {
  let fetch: jest.SpyInstance
  beforeEach(() => {
    fetch = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "https://bridge.withpersona.com/verify" }), {
        status: 200,
      }),
    )
  })
  afterEach(() => {
    fetch.mockRestore()
  })

  it("uses the documented current-customer GET endpoints without idempotency header or caller PII", async () => {
    const client = new BridgeClient()
    const owner = toBridgeCustomerId("customer-owned")
    await client.getHostedKycLink(owner)
    await client.getHostedTosLink(owner)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.sandbox.bridge.xyz/v0/customers/customer-owned/kyc_link",
      "https://api.sandbox.bridge.xyz/v0/customers/customer-owned/tos_acceptance_link",
    ])
    for (const [, request] of fetch.mock.calls) {
      expect(request.method).toBe("GET")
      expect(request.redirect).toBe("error")
      expect(request.body).toBeUndefined()
      expect(request.headers["Idempotency-Key"]).toBeUndefined()
      expect(request.headers["Api-Key"]).toBe("test-api-key")
    }
  })

  it.each([
    ".",
    "..",
    "owned/../foreign",
    "%2e%2e",
    "id?query",
    "id#hash",
    "id\\path",
    "",
    "id\n",
    "é",
    "a".repeat(257),
  ])("rejects unsafe customer ID before any authenticated request: %s", async (value) => {
    const client = new BridgeClient()
    await expect(client.getHostedKycLink(toBridgeCustomerId(value))).rejects.toThrow(
      "Invalid Bridge customer association",
    )
    await expect(client.getHostedTosLink(toBridgeCustomerId(value))).rejects.toThrow(
      "Invalid Bridge customer association",
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

// Real fetch against loopback servers proves the Api-Key never reaches the
// redirect destination. No provider host or production credential is involved.
it.each(["identity", "terms", "create", "existingGET", "existingPOST"])(
  "refuses a cross-origin redirect for %s without forwarding Api-Key",
  async (kind) => {
    let destinationHits = 0
    const destination = createServer((_request, response) => {
      destinationHits++
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ url: "https://bridge.withpersona.com/verify" }))
    })
    const listen = (server: Server) =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          if (!address || typeof address === "string")
            throw new Error("Expected loopback port")
          resolve(address.port)
        })
      })
    const close = (server: Server) =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    const destinationPort = await listen(destination)
    let authenticatedOriginHits = 0
    const origin = createServer((request, response) => {
      if (request.headers["api-key"] === "test-api-key") authenticatedOriginHits++
      request.resume()
      response.writeHead(307, { Location: `http://127.0.0.1:${destinationPort}/capture` })
      response.end()
    })
    try {
      const originPort = await listen(origin)
      const configuration = jest.requireMock("@config").BridgeConfig as {
        baseUrl: string
      }
      configuration.baseUrl = `http://127.0.0.1:${originPort}/v0`
      const client = new BridgeClient()
      const owner = toBridgeCustomerId("75d2f259-6810-4cde-a9b9-83eca42b0ebf")
      const result =
        kind === "identity"
          ? client.getHostedKycLink(owner)
          : kind === "terms"
            ? client.getHostedTosLink(owner)
            : kind === "create"
              ? client.createKycLink(
                  {
                    email: "loopback@example.test",
                    full_name: "Loopback fixture",
                    type: "individual",
                  },
                  "fixture-idempotency-key",
                )
              : kind === "existingGET"
                ? client.getCustomer(owner)
                : client.createCustomer({
                    type: "individual",
                    first_name: "Loopback",
                    last_name: "Fixture",
                    email: "loopback@example.test",
                  })
      await expect(result).rejects.toThrow()
      expect(authenticatedOriginHits).toBe(1)
      expect(destinationHits).toBe(0)
    } finally {
      const configuration = jest.requireMock("@config").BridgeConfig as {
        baseUrl: string
      }
      configuration.baseUrl = "https://api.sandbox.bridge.xyz/v0"
      await close(origin)
      await close(destination)
    }
  },
)
