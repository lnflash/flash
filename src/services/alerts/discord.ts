import { ALERT_DISCORD_WEBHOOK_URL } from "@config"

import { BridgeAlert } from "./index.types"
import {
  DiscordEmbed,
  DiscordEmbedField,
  MAX_DESCRIPTION,
  MAX_FIELDS,
  MAX_TITLE,
  makeFieldBuilder,
  postEmbed,
  truncate,
} from "./discord-embed"

// Warm red for a page, amber for a warning — the embed's left border colour.
const COLOR_CRITICAL = 0xe01e5a
const COLOR_WARNING = 0xf2c744

// Friendly label for the embed author line, so a Fygaro alert doesn't read as a
// "Bridge alert". Falls back to the raw source for anything unmapped.
const SOURCE_LABEL: Record<string, string> = {
  "fygaro-webhook": "Fygaro",
  "bridge-webhook": "Bridge",
  "bridge-api": "Bridge API",
  "ibex": "IBEX",
  "erpnext-audit": "ERPNext",
}

// Turn a context key (snake_case / camelCase) into a Title Case field name:
// "transaction_id" -> "Transaction Id", "balanceUsd" -> "Balance Usd".
const prettyKey = (key: string): string =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())

const contextFields = (
  context: Record<string, unknown> | undefined,
): DiscordEmbedField[] => {
  const fields: DiscordEmbedField[] = []
  if (!context) return fields
  const field = makeFieldBuilder(fields)
  for (const [key, raw] of Object.entries(context)) {
    if (raw === undefined || raw === null) continue
    field(prettyKey(key), String(raw))
  }
  return fields
}

// Discord incoming webhook — a single rich embed (colour by severity, title,
// detail as the description, and each context entry as its own field) instead
// of a raw JSON dump. Delivery is best-effort via postEmbed: the embed is
// clamped to Discord's aggregate limit, a 429 is retried once, and any other
// failure is swallowed as a Warn.
export const sendDiscord = async (alert: BridgeAlert): Promise<void> => {
  if (!ALERT_DISCORD_WEBHOOK_URL) return

  const fields: DiscordEmbedField[] = []
  const field = makeFieldBuilder(fields)
  field("Source", alert.source)
  field("Severity", alert.severity)
  fields.push(...contextFields(alert.context))

  const embed: DiscordEmbed = {
    author: { name: SOURCE_LABEL[alert.source] ?? alert.source },
    title: truncate(alert.title, MAX_TITLE),
    description: alert.detail ? truncate(alert.detail, MAX_DESCRIPTION) : undefined,
    color: alert.severity === "critical" ? COLOR_CRITICAL : COLOR_WARNING,
    fields: fields.slice(0, MAX_FIELDS),
    timestamp: new Date().toISOString(),
  }

  await postEmbed(ALERT_DISCORD_WEBHOOK_URL, embed)
}
