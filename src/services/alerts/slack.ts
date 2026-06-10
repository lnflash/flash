import { ALERT_SLACK_WEBHOOK_URL } from "@config"
import { ErrorLevel } from "@domain/shared"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import axios from "axios"

import { BridgeAlert } from "./index.types"

// Slack / Mattermost-compatible incoming webhook ({ text }).
export const sendSlack = async (alert: BridgeAlert): Promise<void> => {
  if (!ALERT_SLACK_WEBHOOK_URL) return

  const icon = alert.severity === "critical" ? ":rotating_light:" : ":warning:"
  const lines = [
    `${icon} *Bridge alert* - ${alert.title}`,
    `*source:* \`${alert.source}\`  *severity:* \`${alert.severity}\``,
  ]
  if (alert.detail) lines.push(alert.detail)
  if (alert.context) {
    lines.push("```" + JSON.stringify(alert.context, null, 2) + "```")
  }

  try {
    await axios.post(
      ALERT_SLACK_WEBHOOK_URL,
      { text: lines.join("\n") },
      { timeout: 5000, headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    recordExceptionInCurrentSpan({ error, level: ErrorLevel.Warn })
  }
}
