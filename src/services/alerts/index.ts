import { sendPagerDuty } from "./pagerduty"
import { sendSlack } from "./slack"
import { sendDiscord } from "./discord"
import { normalizeDedupKey } from "./dedup-key"
import { claimInformSlot } from "./inform-dedup"
import { BridgeAlert } from "./index.types"

export * from "./index.types"
export { generateDedupKey } from "./dedup-key"

// Deliveries not yet settled. A short-lived process (the cron Job) awaits
// flushAlerts() before it exits, so a page fired near the end of a run is not
// cut off in flight. Every sender has its own request timeout, so the flush is
// bounded.
const inflight = new Set<Promise<void>>()

export const flushAlerts = async (): Promise<void> => {
  await Promise.allSettled([...inflight])
}

/**
 * Fire-and-forget fan-out of a Bridge alert to the configured destinations
 * (ENG-361). Returns immediately; delivery is best-effort: each sender catches
 * its own errors and no-ops when its credential/URL is unset, so it never throws
 * or rejects into the caller (no need to await or handle it). A process about
 * to exit awaits flushAlerts() first.
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

  const delivery = deliver().catch(() => undefined)
  inflight.add(delivery)
  delivery.finally(() => inflight.delete(delivery))
}
