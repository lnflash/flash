jest.mock("@services/alerts/slack", () => ({
  sendSlack: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@services/alerts/discord", () => ({
  sendDiscord: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@services/alerts/pagerduty", () => ({
  sendPagerDuty: jest.fn().mockResolvedValue(undefined),
}))

import { alertBridge } from "@services/alerts"
import { resetInformDedup } from "@services/alerts/inform-dedup"
import { sendDiscord } from "@services/alerts/discord"
import { sendPagerDuty } from "@services/alerts/pagerduty"
import { sendSlack } from "@services/alerts/slack"

describe("alertBridge", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetInformDedup()
  })

  it("fans out critical alerts to inform channels and PagerDuty", async () => {
    alertBridge({
      dedupKey: "bridge-api:5xx",
      source: "bridge-api",
      severity: "critical",
      title: "Bridge API 502 on GET /transfers",
    })

    await Promise.resolve()

    expect(sendSlack).toHaveBeenCalledTimes(1)
    expect(sendDiscord).toHaveBeenCalledTimes(1)
    expect(sendPagerDuty).toHaveBeenCalledTimes(1)
    expect(sendPagerDuty).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: "bridge-api:5xx" }),
    )
  })

  it("does not page PagerDuty for warning alerts", async () => {
    alertBridge({
      dedupKey: "ibex:warning:tx_1",
      source: "ibex",
      severity: "warning",
      title: "IBEX movement failed",
    })

    await Promise.resolve()

    expect(sendSlack).toHaveBeenCalledTimes(1)
    expect(sendDiscord).toHaveBeenCalledTimes(1)
    expect(sendPagerDuty).not.toHaveBeenCalled()
  })

  it("suppresses duplicate Slack and Discord alerts for the same dedup key", async () => {
    const alert = {
      dedupKey: "bridge-api:5xx",
      source: "bridge-api" as const,
      severity: "critical" as const,
      title: "Bridge API 502 on GET /transfers",
    }

    alertBridge(alert)
    alertBridge(alert)
    alertBridge(alert)

    await Promise.resolve()

    expect(sendSlack).toHaveBeenCalledTimes(1)
    expect(sendDiscord).toHaveBeenCalledTimes(1)
    expect(sendPagerDuty).toHaveBeenCalledTimes(3)
  })
})
