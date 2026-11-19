// AC1: listAllEvents surfaces orphan events for ops triage tooling

import http from "http"
import { AddressInfo } from "net"

jest.mock("@config", () => ({
  BridgeConfig: {
    apiKey: "test-api-key",
    baseUrl: "https://api.sandbox.bridge.xyz/v0",
  },
}))

jest.mock("@services/alerts", () => ({
  alertBridge: jest.fn(),
  generateDedupKey: jest.requireActual("@services/alerts/dedup-key").generateDedupKey,
}))

import { BridgeClient, listAllEvents, BridgeWebhookEvent } from "@services/bridge/client"
import { alertBridge } from "@services/alerts"
import {
  BridgeApiError,
  BridgeTimeoutError,
  BridgeUnexpectedResponseError,
  BridgeUnreadableResponseError,
  isBridgeNotAllowedError,
} from "@services/bridge/errors"

// A real fetch Response carrying `body` as JSON.
const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init })

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeEvent = (id: string): BridgeWebhookEvent => ({
  id,
  event_type: "transfer.completed",
  payload: { transfer_id: id },
  created_at: "2026-05-01T10:00:00Z",
})

// ── listAllEvents ─────────────────────────────────────────────────────────────

describe("listAllEvents", () => {
  let listEventsSpy: jest.SpyInstance

  beforeEach(() => {
    listEventsSpy = jest.spyOn(BridgeClient.prototype, "listEvents")
  })

  afterEach(() => {
    listEventsSpy.mockRestore()
  })

  it("yields all events from a single page", async () => {
    listEventsSpy.mockResolvedValue({
      data: [makeEvent("e1"), makeEvent("e2")],
      has_more: false,
      cursor: undefined,
    })

    const events: BridgeWebhookEvent[] = []
    for await (const e of listAllEvents()) {
      events.push(e)
    }

    expect(events).toHaveLength(2)
    expect(events.map((e) => e.id)).toEqual(["e1", "e2"])
    expect(listEventsSpy).toHaveBeenCalledTimes(1)
  })

  it("paginates across multiple pages until has_more is false", async () => {
    listEventsSpy
      .mockResolvedValueOnce({
        data: [makeEvent("e1"), makeEvent("e2")],
        has_more: true,
        cursor: "cursor-page-2",
      })
      .mockResolvedValueOnce({
        data: [makeEvent("e3"), makeEvent("e4")],
        has_more: true,
        cursor: "cursor-page-3",
      })
      .mockResolvedValueOnce({
        data: [makeEvent("e5")],
        has_more: false,
        cursor: undefined,
      })

    const events: BridgeWebhookEvent[] = []
    for await (const e of listAllEvents()) {
      events.push(e)
    }

    expect(events).toHaveLength(5)
    expect(events.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5"])
    expect(listEventsSpy).toHaveBeenCalledTimes(3)
  })

  it("passes the cursor from page N as 'after' on page N+1", async () => {
    listEventsSpy
      .mockResolvedValueOnce({
        data: [makeEvent("e1")],
        has_more: true,
        cursor: "cur-abc",
      })
      .mockResolvedValueOnce({
        data: [makeEvent("e2")],
        has_more: false,
        cursor: undefined,
      })

    const drained: BridgeWebhookEvent[] = []
    for await (const event of listAllEvents()) {
      drained.push(event)
    }

    expect(drained).toHaveLength(2)
    expect(listEventsSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ after: undefined }),
    )
    expect(listEventsSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ after: "cur-abc" }),
    )
  })

  it("always requests page_size 100", async () => {
    listEventsSpy.mockResolvedValue({ data: [], has_more: false, cursor: undefined })

    const drained: BridgeWebhookEvent[] = []
    for await (const event of listAllEvents()) {
      drained.push(event)
    }

    expect(drained).toHaveLength(0)
    expect(listEventsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ page_size: 100 }),
    )
  })

  it("filters events locally by start/end window and does not forward start/end to Bridge API", async () => {
    const inWindow = makeEvent("e1") // created_at: "2026-05-01T10:00:00Z" — inside window
    const tooEarly = { ...makeEvent("e2"), created_at: "2026-04-30T23:59:59Z" }

    listEventsSpy
      .mockResolvedValueOnce({ data: [inWindow, tooEarly], has_more: true, cursor: "c1" })
      .mockResolvedValueOnce({
        data: [makeEvent("e3")],
        has_more: false,
        cursor: undefined,
      })

    const drained: BridgeWebhookEvent[] = []
    for await (const event of listAllEvents({
      start: "2026-05-01T00:00:00Z",
      end: "2026-05-02T00:00:00Z",
      event_type: "transfer.completed",
    })) {
      drained.push(event)
    }

    // e2 is before the window start — only e1 and e3 pass through
    expect(drained.map((e) => e.id)).toEqual(["e1", "e3"])
    expect(listEventsSpy).toHaveBeenCalledTimes(2)
    for (const call of listEventsSpy.mock.calls) {
      // start/end must NOT be sent to Bridge — it only understands cursor params
      expect(call[0]).not.toHaveProperty("start")
      expect(call[0]).not.toHaveProperty("end")
      expect(call[0]).not.toHaveProperty("start_date")
      expect(call[0]).not.toHaveProperty("end_date")
      // event_type is still forwarded (mapped to category inside listEvents)
      expect(call[0]).toMatchObject({ event_type: "transfer.completed" })
    }
  })

  it("yields nothing and makes one call when the first page is empty", async () => {
    listEventsSpy.mockResolvedValue({ data: [], has_more: false, cursor: undefined })

    const events: BridgeWebhookEvent[] = []
    for await (const e of listAllEvents()) {
      events.push(e)
    }

    expect(events).toHaveLength(0)
    expect(listEventsSpy).toHaveBeenCalledTimes(1)
  })

  it("stops immediately if has_more is false even when cursor is present", async () => {
    listEventsSpy.mockResolvedValue({
      data: [makeEvent("e1")],
      has_more: false,
      cursor: "stale-cursor",
    })

    const events: BridgeWebhookEvent[] = []
    for await (const e of listAllEvents()) {
      events.push(e)
    }

    expect(events).toHaveLength(1)
    expect(listEventsSpy).toHaveBeenCalledTimes(1)
  })
})

describe("BridgeClient transfer deletion", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = jest.fn().mockImplementation(async () =>
      jsonResponse({
        id: "tr_123",
        amount: "2.5",
        currency: "usd",
        state: "canceled",
        source: { payment_rail: "ethereum", currency: "usdt" },
        destination: { payment_rail: "ach", currency: "usd" },
        created_at: "2026-06-17T00:00:00Z",
        updated_at: "2026-06-17T00:00:00Z",
      }),
    )
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("does not send an Idempotency-Key on DELETE transfer requests", async () => {
    const client = new BridgeClient()

    await client.deleteTransfer("tr_123" as never)

    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(init.method).toBe("DELETE")
    expect(init.headers["Idempotency-Key"]).toBeUndefined()
  })
})

describe("BridgeClient Plaid exchange idempotency", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = jest
      .fn()
      .mockImplementation(async () => jsonResponse({ message: "ok" }))
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("does not send an Idempotency-Key on the plaid public_token exchange", async () => {
    // Bridge explicitly disables the header on this resource and 400s when it
    // is present ("Cannot set Idempotency-Key on this request") — found live
    // on the first production Plaid link (flash-mobile#668 device test).
    const client = new BridgeClient()

    await client.exchangePlaidPublicToken("lt_abc", "public-token-1")

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toContain("/plaid_exchange_public_token/lt_abc")
    expect(init.method).toBe("POST")
    expect(init.headers["Idempotency-Key"]).toBeUndefined()
  })

  it("still auto-generates an Idempotency-Key for plaid link-token requests", async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async () =>
      jsonResponse({ link_token: "lt_abc", expires_at: "later" }),
    )
    const client = new BridgeClient()

    await client.createPlaidLinkRequest("cust_1" as never)

    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(init.method).toBe("POST")
    expect(init.headers["Idempotency-Key"]).toEqual(expect.any(String))
    expect(init.headers["Idempotency-Key"]).not.toHaveLength(0)
  })
})

// ENG-889: Bridge sends no webhook for wire recalls, so they are polled.
describe("BridgeClient.listFundsRequests", () => {
  const originalFetch = global.fetch
  const fundsRequest = {
    id: "fr_1",
    deposit_id: "deposit_1",
    customer_id: "cust_1",
    amount: "5000.0",
    currency: "usd",
    payment_rail: "wire",
    fraud: true,
    notice_date: "2026-11-18",
    created_at: "2026-11-18T10:00:00.000Z",
  }

  beforeEach(() => {
    global.fetch = jest
      .fn()
      .mockImplementation(async () => jsonResponse({ count: 1, data: [fundsRequest] }))
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("GETs /funds_requests with Bridge's query names and no Idempotency-Key", async () => {
    const client = new BridgeClient()

    const result = await client.listFundsRequests({
      limit: 100,
      startingAfter: "fr_0",
      customerId: "cust_1",
      fraud: true,
      noticeDateStartingOn: "2026-10-20",
      noticeDateEndingOn: "2026-11-19",
    })

    expect(result).toEqual({ count: 1, data: [fundsRequest] })
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/v0/funds_requests")
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      limit: "100",
      starting_after: "fr_0",
      customer_id: "cust_1",
      fraud: "true",
      notice_date_starting_on: "2026-10-20",
      notice_date_ending_on: "2026-11-19",
    })
    expect(init.method).toBe("GET")
    expect(init.headers["Idempotency-Key"]).toBeUndefined()
  })

  it("sends no query string when called without filters", async () => {
    await new BridgeClient().listFundsRequests()

    const [url] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe("https://api.sandbox.bridge.xyz/v0/funds_requests")
  })

  it("returns an empty page when data is an empty array", async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async () =>
      jsonResponse({ count: 0, data: [] }),
    )

    await expect(new BridgeClient().listFundsRequests()).resolves.toEqual({
      count: 0,
      data: [],
    })
  })

  it.each([
    ["a body without data", {}],
    ["data that is not an array", { count: 3, data: { id: "fr_1" } }],
    ["a null data", { data: null }],
    ["a null body", null],
  ])("rejects %s instead of reading it as an empty page", async (_, body) => {
    ;(global.fetch as jest.Mock).mockImplementation(async () => jsonResponse(body))

    await expect(new BridgeClient().listFundsRequests()).rejects.toBeInstanceOf(
      BridgeUnexpectedResponseError,
    )
  })

  it("throws BridgeApiError on a 4xx", async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async () =>
      jsonResponse({ message: "no access" }, { status: 403, statusText: "Forbidden" }),
    )

    await expect(new BridgeClient().listFundsRequests()).rejects.toThrow(
      "Bridge API error: 403 Forbidden",
    )
  })
})

// ENG-889: the customer status watch lists every Bridge customer.
describe("BridgeClient.listCustomers", () => {
  const originalFetch = global.fetch
  const customer = {
    id: "cust_1",
    type: "individual",
    status: "deposits_restricted",
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-19T00:00:00.000Z",
  }

  beforeEach(() => {
    global.fetch = jest
      .fn()
      .mockImplementation(async () => jsonResponse({ count: 1, data: [customer] }))
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("GETs /customers with limit and starting_after and no Idempotency-Key", async () => {
    const result = await new BridgeClient().listCustomers({
      limit: 100,
      startingAfter: "cust_0",
    })

    expect(result).toEqual({ count: 1, data: [customer] })
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/v0/customers")
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      limit: "100",
      starting_after: "cust_0",
    })
    expect(init.method).toBe("GET")
    expect(init.headers["Idempotency-Key"]).toBeUndefined()
  })

  it("returns an empty page when data is an empty array", async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async () =>
      jsonResponse({ count: 0, data: [] }),
    )

    await expect(new BridgeClient().listCustomers()).resolves.toEqual({
      count: 0,
      data: [],
    })
  })

  it.each([
    ["a body without data", {}],
    ["data that is not an array", { count: 3, data: "cust_1" }],
    ["a null data", { data: null }],
    ["an empty body", undefined],
  ])("rejects %s instead of reading it as an empty page", async (_, body) => {
    ;(global.fetch as jest.Mock).mockImplementation(async () =>
      body === undefined ? new Response("", { status: 200 }) : jsonResponse(body),
    )

    await expect(new BridgeClient().listCustomers()).rejects.toBeInstanceOf(
      BridgeUnexpectedResponseError,
    )
  })
})

// ENG-889: production answers GET /funds_requests with 401 not_allowed; the
// recall watch must tell that apart from other failures.
describe("BridgeApiError code", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  const failWith = (status: number, body: unknown) => {
    global.fetch = jest
      .fn()
      .mockImplementation(async () =>
        jsonResponse(body, { status: status, statusText: "Unauthorized" }),
      )
  }

  it("carries the status and Bridge's error code", async () => {
    failWith(401, {
      code: "not_allowed",
      message: "Insufficient permissions for this endpoint",
    })

    const error = await new BridgeClient().listFundsRequests().catch((e) => e)

    expect(error).toBeInstanceOf(BridgeApiError)
    expect(error.statusCode).toBe(401)
    expect(error.code).toBe("not_allowed")
    expect(isBridgeNotAllowedError(error)).toBe(true)
  })

  it("is not 'not allowed' for another 401 code or another status", () => {
    expect(
      isBridgeNotAllowedError(new BridgeApiError("x", 401, { code: "unauthorized" })),
    ).toBe(false)
    expect(
      isBridgeNotAllowedError(new BridgeApiError("x", 403, { code: "not_allowed" })),
    ).toBe(false)
    expect(isBridgeNotAllowedError(new BridgeApiError("x", 401, null))).toBe(false)
    expect(isBridgeNotAllowedError(new Error("not_allowed"))).toBe(false)
  })

  it("leaves code undefined when the body has none", () => {
    expect(new BridgeApiError("x", 500, "Bad Gateway").code).toBeUndefined()
    expect(new BridgeApiError("x", 500, { code: 7 }).code).toBeUndefined()
  })
})

// ENG-889: the request timeout also covers reading the body. On the first
// production run a 100 customer page's body read was aborted, the client
// returned null with status 200, and the watch recorded a 0 customer baseline.
describe("BridgeClient.request: success bodies", () => {
  const originalFetch = global.fetch
  const { BridgeConfig } = jest.requireMock("@config")

  beforeEach(() => {
    ;(alertBridge as jest.Mock).mockClear()
  })

  afterEach(() => {
    global.fetch = originalFetch
    delete BridgeConfig.timeoutMs
  })

  // A real server that sends 200 and the start of a page, then stalls past
  // the timeout before finishing the body.
  const stallingServer = async (): Promise<{ url: string; close: () => void }> => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.write('{"count":100,"data":[')
      const timer = setTimeout(() => res.end("]}"), 2_000)
      res.on("close", () => clearTimeout(timer))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    return {
      url: `http://127.0.0.1:${port}/v0`,
      close: () => {
        server.closeAllConnections()
        server.close()
      },
    }
  }

  it("throws a timeout, not an empty page, when the body read is aborted", async () => {
    const server = await stallingServer()
    const originalBaseUrl = BridgeConfig.baseUrl
    BridgeConfig.baseUrl = server.url
    BridgeConfig.timeoutMs = 100
    try {
      const error = await new BridgeClient().listCustomers({ limit: 100 }).catch((e) => e)

      expect(error).toBeInstanceOf(BridgeTimeoutError)
      expect(alertBridge).toHaveBeenCalledWith(
        expect.objectContaining({ dedupKey: "bridge-api:timeout", severity: "critical" }),
      )
    } finally {
      BridgeConfig.baseUrl = originalBaseUrl
      server.close()
    }
  })

  it("throws a timeout when the body read rejects with an AbortError", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.reject(new DOMException("This operation was aborted", "AbortError")),
    } as unknown as Response)

    await expect(
      new BridgeClient().getCustomer("cust_1" as never),
    ).rejects.toBeInstanceOf(BridgeTimeoutError)
  })

  it("throws an unreadable-response error with the status on a body that is not JSON", async () => {
    global.fetch = jest
      .fn()
      .mockImplementation(
        async () => new Response('{"count":100,"data":[{"id"', { status: 200 }),
      )

    const error = await new BridgeClient().getCustomer("cust_1" as never).catch((e) => e)

    expect(error).toBeInstanceOf(BridgeUnreadableResponseError)
    expect(error).toBeInstanceOf(BridgeApiError)
    expect(error.statusCode).toBe(200)
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "bridge-api:unreadable-body",
        severity: "critical",
      }),
    )
  })

  it("throws an unreadable-response error when the connection drops mid-body", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.reject(new TypeError("terminated")),
    } as unknown as Response)

    const error = await new BridgeClient().getTransfer("tr_1" as never).catch((e) => e)

    expect(error).toBeInstanceOf(BridgeUnreadableResponseError)
    expect(error.message).toContain("terminated")
  })

  it("returns null for a 204 with no body", async () => {
    global.fetch = jest
      .fn()
      .mockImplementation(async () => new Response(null, { status: 204 }))

    await expect(new BridgeClient().deleteTransfer("tr_1" as never)).resolves.toBeNull()
    expect(alertBridge).not.toHaveBeenCalled()
  })

  it("returns null for a success with an empty body", async () => {
    global.fetch = jest
      .fn()
      .mockImplementation(async () => new Response("", { status: 200 }))

    await expect(
      new BridgeClient().deleteExternalAccount("cust_1" as never, "ea_1" as never),
    ).resolves.toBeNull()
    expect(alertBridge).not.toHaveBeenCalled()
  })

  it("keeps a 4xx whose body is not JSON a BridgeApiError with no body", async () => {
    global.fetch = jest.fn().mockImplementation(
      async () =>
        new Response("<html>Not Found</html>", {
          status: 404,
          statusText: "Not Found",
        }),
    )

    const error = await new BridgeClient().getCustomer("cust_1" as never).catch((e) => e)

    expect(error).toBeInstanceOf(BridgeApiError)
    expect(error).not.toBeInstanceOf(BridgeUnreadableResponseError)
    expect(error.statusCode).toBe(404)
    expect(error.response).toBeNull()
  })
})
