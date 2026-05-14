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

  it("forwards start_date, end_date and event_type filters to every page", async () => {
    listEventsSpy
      .mockResolvedValueOnce({ data: [makeEvent("e1")], has_more: true, cursor: "c1" })
      .mockResolvedValueOnce({
        data: [makeEvent("e2")],
        has_more: false,
        cursor: undefined,
      })

    const params = {
      start_date: "2026-05-01T00:00:00Z",
      end_date: "2026-05-02T00:00:00Z",
      event_type: "transfer.completed",
    }

    const drained: BridgeWebhookEvent[] = []
    for await (const event of listAllEvents(params)) {
      drained.push(event)
    }

    expect(drained).toHaveLength(2)
    expect(listEventsSpy).toHaveBeenCalledTimes(2)
    for (const call of listEventsSpy.mock.calls) {
      expect(call[0]).toMatchObject(params)
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
