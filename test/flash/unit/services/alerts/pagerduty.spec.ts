jest.mock("@config", () => ({
  ALERT_PAGERDUTY_ROUTING_KEY: "test-routing-key",
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("axios", () => ({
  post: jest.fn().mockResolvedValue({ status: 202 }),
}))

import axios from "axios"
import { sendPagerDuty } from "@services/alerts/pagerduty"

describe("sendPagerDuty", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("includes dedup_key in the Events API v2 payload", async () => {
    await sendPagerDuty({
      dedupKey: "bridge-api:5xx",
      source: "bridge-api",
      severity: "critical",
      title: "Bridge API 502 on GET /transfers",
      context: { method: "GET", path: "/transfers" },
    })

    expect(axios.post).toHaveBeenCalledWith(
      "https://events.pagerduty.com/v2/enqueue",
      expect.objectContaining({
        routing_key: "test-routing-key",
        event_action: "trigger",
        dedup_key: "bridge-api:5xx",
        payload: expect.objectContaining({
          summary: "[bridge:bridge-api] Bridge API 502 on GET /transfers",
          severity: "critical",
        }),
      }),
      expect.any(Object),
    )
  })
})
