import { ALERT_PAGERDUTY_ROUTING_KEY } from "@config"
import { ErrorLevel } from "@domain/shared"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import axios from "axios"

import { BridgeAlert } from "./index.types"

const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue"

// PagerDuty Events API v2 triggers a paging incident. "critical" and
// "warning" are both valid PD payload severities, so we pass them through.
export const sendPagerDuty = async (alert: BridgeAlert): Promise<void> => {
  if (!ALERT_PAGERDUTY_ROUTING_KEY) return

  try {
    await axios.post(
      PAGERDUTY_EVENTS_URL,
      {
        routing_key: ALERT_PAGERDUTY_ROUTING_KEY,
        event_action: "trigger",
        dedup_key: alert.dedupKey,
        payload: {
          summary: `[bridge:${alert.source}] ${alert.title}`,
          severity: alert.severity,
          source: "flash-bridge",
          custom_details: { ...alert.context, detail: alert.detail },
        },
      },
      { timeout: 5000, headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    recordExceptionInCurrentSpan({ error, level: ErrorLevel.Warn })
  }
}
