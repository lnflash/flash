import { ALERT_DISCORD_WEBHOOK_URL } from "@config"
import { ErrorLevel } from "@domain/shared"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import axios from "axios"

import { BridgeAlert } from "./index.types"

// Discord embed limits: 25 fields, each value <= 1024 chars, title <= 256,
// description <= 4096. We stay well under these; the guards below keep a large
// context object from tripping them.
const MAX_FIELDS = 25
const MAX_FIELD_VALUE = 1024
const MAX_TITLE = 256
const MAX_DESCRIPTION = 4096

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

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max - 1) + "…" : value

const contextFields = (
  context: Record<string, unknown> | undefined,
): { name: string; value: string; inline: boolean }[] => {
  if (!context) return []
  const fields: { name: string; value: string; inline: boolean }[] = []
  for (const [key, raw] of Object.entries(context)) {
    if (raw === undefined || raw === null) continue
    const value = String(raw)
    // Discord rejects empty field values.
    if (value.length === 0) continue
    fields.push({
      name: truncate(prettyKey(key), MAX_TITLE),
      value: truncate(value, MAX_FIELD_VALUE),
      inline: true,
    })
  }
  return fields
}

// Discord incoming webhook — a single rich embed (colour by severity, title,
// detail as the description, and each context entry as its own field) instead
// of a raw JSON dump.
export const sendDiscord = async (alert: BridgeAlert): Promise<void> => {
  if (!ALERT_DISCORD_WEBHOOK_URL) return

  const fields = [
    { name: "Source", value: alert.source, inline: true },
    { name: "Severity", value: alert.severity, inline: true },
    ...contextFields(alert.context),
  ].slice(0, MAX_FIELDS)

  const embed = {
    author: { name: SOURCE_LABEL[alert.source] ?? alert.source },
    title: truncate(alert.title, MAX_TITLE),
    description: alert.detail ? truncate(alert.detail, MAX_DESCRIPTION) : undefined,
    color: alert.severity === "critical" ? COLOR_CRITICAL : COLOR_WARNING,
    fields,
    timestamp: new Date().toISOString(),
  }

  try {
    await axios.post(
      ALERT_DISCORD_WEBHOOK_URL,
      { embeds: [embed] },
      { timeout: 5000, headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    recordExceptionInCurrentSpan({ error, level: ErrorLevel.Warn })
  }
}
