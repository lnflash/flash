import { ErrorLevel } from "@domain/shared"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import axios, { isAxiosError } from "axios"

/**
 * Shared Discord rich-embed contract for the alert senders (discord.ts and
 * ops-events.ts). One place for Discord's documented limits, the field builder,
 * the aggregate clamp, and the rate-limit-aware POST — so a future Discord
 * change (a new limit, different retry logic) is made once, not twice.
 *
 * Discord embed limits: 25 fields, each value <= 1024 chars, each name <= 256,
 * title <= 256, description <= 4096, and — the one the per-field caps do NOT
 * bound — an aggregate <= 6000 chars summed across title + description + every
 * field name + every field value (+ author/footer text). clampEmbedToBudget
 * enforces that aggregate; postEmbed applies it before every POST.
 */

export const MAX_FIELDS = 25
export const MAX_FIELD_VALUE = 1024
export const MAX_TITLE = 256
export const MAX_DESCRIPTION = 4096
export const MAX_EMBED_TOTAL = 6000

// A little under Discord's hard 6000 aggregate, leaving headroom for embed
// scaffolding that also counts toward the limit (author line, timestamp label).
const AGGREGATE_BUDGET = 5900

const POST_TIMEOUT_MS = 5_000

export type DiscordEmbedField = { name: string; value: string; inline: boolean }

export type DiscordEmbed = {
  author?: { name: string }
  title: string
  description?: string
  color: number
  fields: DiscordEmbedField[]
  timestamp: string
}

// Trim a string to at most `max` characters, marking the cut with an ellipsis
// so a reader can tell it was truncated. The ellipsis counts toward the cap:
// the result length is never greater than `max`.
export const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max - 1) + "…" : value

// A closure that appends non-empty, name-capped, value-capped fields to the
// given array. Shared so both alert senders build fields identically.
export const makeFieldBuilder =
  (fields: DiscordEmbedField[]) =>
  (name: string, value: string | undefined | null, inline = true): void => {
    if (value === undefined || value === null || value.length === 0) return
    fields.push({
      name: truncate(name, MAX_TITLE),
      value: truncate(value, MAX_FIELD_VALUE),
      inline,
    })
  }

const fieldCost = (field: DiscordEmbedField): number =>
  field.name.length + field.value.length

// Keep an embed under Discord's aggregate character limit. The per-field caps
// bound each part but not their sum, so a caller that stuffs a large value into
// one field can still build a >6000-char embed that Discord 400s (which
// postEmbed would then swallow as a Warn, silently dropping the alert). We trim
// the description if it alone blows the budget, then drop trailing fields until
// the running total fits.
export const clampEmbedToBudget = (embed: DiscordEmbed): DiscordEmbed => {
  const scaffold = (embed.author?.name.length ?? 0) + embed.title.length
  let remaining = AGGREGATE_BUDGET - scaffold

  let description = embed.description
  if (description !== undefined) {
    if (remaining <= 1) {
      description = undefined
    } else if (description.length > remaining) {
      description = truncate(description, remaining)
    }
    remaining -= description?.length ?? 0
  }

  const fields: DiscordEmbedField[] = []
  for (const field of embed.fields) {
    const cost = fieldCost(field)
    if (cost > remaining) break
    remaining -= cost
    fields.push(field)
  }

  if (fields.length === embed.fields.length && description === embed.description) {
    return embed
  }
  return { ...embed, description, fields }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Discord rate-limit responses carry retry_after in seconds (possibly float),
// in the body and/or the Retry-After header. Returns the wait in ms for a 429,
// or undefined for any other (terminal) error.
const retryAfterMs = (error: unknown): number | undefined => {
  if (!isAxiosError(error) || error.response?.status !== 429) return undefined
  const body = error.response.data as { retry_after?: number } | undefined
  const retryAfter = body?.retry_after ?? Number(error.response.headers?.["retry-after"])
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter)) return 1_000
  return Math.ceil(retryAfter * 1000)
}

/**
 * POST a single rich embed to a Discord incoming webhook. Best-effort: never
 * throws. Clamps the embed to Discord's aggregate limit first; on HTTP 429 it
 * honors Discord's retry_after once; any other failure (or a failed retry) is
 * recorded as a Warn and swallowed.
 */
export const postEmbed = async (
  url: string,
  embed: DiscordEmbed,
  timeoutMs: number = POST_TIMEOUT_MS,
): Promise<void> => {
  const body = { embeds: [clampEmbedToBudget(embed)] }
  const post = () =>
    axios.post(url, body, {
      timeout: timeoutMs,
      headers: { "Content-Type": "application/json" },
    })

  try {
    await post()
  } catch (error) {
    const waitMs = retryAfterMs(error)
    if (waitMs === undefined) {
      recordExceptionInCurrentSpan({ error, level: ErrorLevel.Warn })
      return
    }
    await sleep(waitMs)
    try {
      await post()
    } catch (retryError) {
      recordExceptionInCurrentSpan({ error: retryError, level: ErrorLevel.Warn })
    }
  }
}
