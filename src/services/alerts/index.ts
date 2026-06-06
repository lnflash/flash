import { sendPagerDuty } from "./pagerduty"
import { sendSlack } from "./slack"
import { sendDiscord } from "./discord"
import { BridgeAlert } from "./index.types"

export * from "./index.types"

/**
 * Fire-and-forget fan-out of a Bridge alert to the configured destinations
 * (ENG-361). Returns immediately; delivery is best-effort — each sender catches
 * its own errors and no-ops when its credential/URL is unset, so it never throws
 * or rejects into the caller (no need to await or handle it).
 *
 * Routing:
 *   - critical → page on-call (PagerDuty) + inform (Slack/Mattermost, Discord)
 *   - warning  → inform (Slack/Mattermost, Discord) only
 */
export const alertBridge = (alert: BridgeAlert): void => {
  const deliver = async () => {
    const senders = [sendSlack(alert), sendDiscord(alert)]
    if (alert.severity === "critical") {
      senders.push(sendPagerDuty(alert))
    }
    await Promise.allSettled(senders)
  }
  deliver().catch(() => undefined)
}
