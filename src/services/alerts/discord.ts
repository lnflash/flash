import { ALERT_DISCORD_WEBHOOK_URL } from "@config"
import { ErrorLevel } from "@domain/shared"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import axios from "axios"

import { BridgeAlert } from "./index.types"

// Discord caps message content at 2000 chars; leave headroom.
const DISCORD_CONTENT_MAX = 1900

// Discord incoming webhook ({ content }).
export const sendDiscord = async (alert: BridgeAlert): Promise<void> => {
  if (!ALERT_DISCORD_WEBHOOK_URL) return

  const label = alert.severity === "critical" ? "[CRITICAL]" : "[WARNING]"
  let content = `${label} **Bridge alert** - ${alert.title}\nsource: \`${alert.source}\` | severity: \`${alert.severity}\``
  if (alert.detail) content += `\n${alert.detail}`
  if (alert.context) {
    content += "\n```json\n" + JSON.stringify(alert.context, null, 2) + "\n```"
  }
  if (content.length > DISCORD_CONTENT_MAX) {
    content = content.slice(0, DISCORD_CONTENT_MAX) + "..."
  }

  try {
    await axios.post(
      ALERT_DISCORD_WEBHOOK_URL,
      { content },
      { timeout: 5000, headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    recordExceptionInCurrentSpan({ error, level: ErrorLevel.Warn })
  }
}
