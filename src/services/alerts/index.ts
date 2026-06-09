import { sendPagerDuty } from "./pagerduty"
import { sendSlack } from "./slack"
import { sendDiscord } from "./discord"
import { normalizeDedupKey } from "./dedup-key"
import { claimInformSlot } from "./inform-dedup"
import { BridgeAlert } from "./index.types"

export * from "./index.types"
export { generateDedupKey } from "./dedup-key"

/**
 * Fire-and-forget fan-out of a Bridge alert to the configured destinations
 * (ENG-361). Returns immediately; delivery is best-effort: each sender catches
 * its own errors and no-ops when its credential/URL is unset, so it never throws
 * or rejects into the caller (no need to await or handle it).
 *
 * Routing:
 *   - critical: page on-call (PagerDuty) + inform (Slack/Mattermost, Discord)
 *   - warning: inform (Slack/Mattermost, Discord) only
 *
 * Dedup:
 *   - PagerDuty: Events API v2 dedup_key groups triggers into one incident.
 *   - Slack / Discord: first alert per dedup key within TTL only.
 */
export const alertBridge = (alert: BridgeAlert): void => {
  const dedupKey = normalizeDedupKey(alert.dedupKey)
  const alertWithKey: BridgeAlert = { ...alert, dedupKey }

  const deliver = async () => {
    const senders: Promise<void>[] = []

    if (claimInformSlot(dedupKey)) {
      senders.push(sendSlack(alertWithKey), sendDiscord(alertWithKey))
    }

    if (alert.severity === "critical") {
      senders.push(sendPagerDuty(alertWithKey))
    }

    if (senders.length > 0) {
      await Promise.allSettled(senders)
    }
  }

  deliver().catch(() => undefined)
}
