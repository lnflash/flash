// AC1: listAllEvents surfaces orphan events for ops triage tooling

jest.mock("@config", () => ({
  BridgeConfig: {
    apiKey: "test-api-key",
    baseUrl: "https://api.sandbox.bridge.xyz/v0",
  },
}))

import { BridgeClient, listAllEvents, BridgeWebhookEvent } from "@services/bridge/client"

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
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "tr_123",
        amount: "2.5",
        currency: "usd",
        state: "canceled",
        source: { payment_rail: "ethereum", currency: "usdt" },
        destination: { payment_rail: "ach", currency: "usd" },
        created_at: "2026-06-17T00:00:00Z",
        updated_at: "2026-06-17T00:00:00Z",
      }),
    } as Response)
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
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: "ok" }),
    } as Response)
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
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ link_token: "lt_abc", expires_at: "later" }),
    } as Response)
    const client = new BridgeClient()

    await client.createPlaidLinkRequest("cust_1" as never)

    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(init.method).toBe("POST")
    expect(init.headers["Idempotency-Key"]).toEqual(expect.any(String))
    expect(init.headers["Idempotency-Key"]).not.toHaveLength(0)
  })
})
