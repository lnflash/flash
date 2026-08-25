import { NETWORK, OPS_DISCORD_WEBHOOK_URL } from "@config"
import { ErrorLevel, JMDAmount, USDAmount, USDTAmount } from "@domain/shared"
import { recordExceptionInCurrentSpan } from "@services/tracing"

import {
  DiscordEmbed,
  DiscordEmbedField,
  makeFieldBuilder,
  postEmbed,
} from "./discord-embed"

/**
 * Fire-and-forget ops event feed: posts color-coded Discord embeds to
 * OPS_DISCORD_WEBHOOK_URL when users move through key flows (verification,
 * upgrade, cashout, deposit, transfer), so the ops channel reads as a funnel.
 *
 * Delivery is best-effort: no-op when the webhook URL is unset, never throws,
 * never awaited by callers (mirrors alertBridge — returns void, all errors are
 * swallowed internally). Events are sent sequentially through a small
 * in-process FIFO queue; on HTTP 429 the sender honors Discord's retry_after
 * once; when the queue overflows, oldest events are dropped and a single
 * summary embed is emitted.
 */

export type OpsFlow = "verification" | "upgrade" | "cashout" | "deposit" | "transfer"

export type OpsStatus = "success" | "pending" | "failed"

export interface OpsEvent {
  flow: OpsFlow
  phase: string // e.g. "otp-sent", "otp-verified", "promoted", "initiated", "succeeded", "failed"
  status: OpsStatus // drives embed color: green/amber/red
  accountId?: string
  userId?: string
  deviceId?: string
  phone?: string // masked before sending
  email?: string // masked before sending
  amount?: { value: number | bigint | string; currency: string }
  step?: string // e.g. failing cashout step
  error?: string // typed domain error name
  meta?: Record<string, string> // extra ids (offerId, txId...) — long ids get truncated
}

const EMBED_COLOR: Record<OpsStatus, number> = {
  success: 0x2ecc71, // green
  pending: 0xf39c12, // amber
  failed: 0xe74c3c, // red
}

const FLOW_EMOJI: Record<OpsFlow, string> = {
  verification: "📲",
  upgrade: "⬆️",
  cashout: "💸",
  deposit: "💰",
  transfer: "🔁",
}

const MAX_QUEUE = 50
const FETCH_TIMEOUT_MS = 3_000
const MAX_ID_LENGTH = 12
const ID_PREFIX_LENGTH = 8

// --- Masking / formatting helpers (exported for tests) ---

// +18765550100 -> +1876…00. Never reveals the middle of the number; short
// inputs collapse to a prefix only so first4+last2 can't reconstruct them.
export const maskPhone = (phone: string): string => {
  const plus = phone.startsWith("+") ? "+" : ""
  const digits = phone.replace(/\D/g, "")
  if (digits.length === 0) return `${plus}…`
  if (digits.length <= 6) return `${plus}${digits.slice(0, 2)}…`
  return `${plus}${digits.slice(0, 4)}…${digits.slice(-2)}`
}

// jabari@gmail.com -> j***@gmail.com
export const maskEmail = (email: string): string => {
  const at = email.indexOf("@")
  if (at <= 0) return "***"
  return `${email[0]}***@${email.slice(at + 1)}`
}

// Long ids (mongo ObjectIds, tx hashes...) -> first 8 chars + "…" so the
// channel can still correlate events without leaking full identifiers.
export const truncateId = (id: string): string =>
  id.length > MAX_ID_LENGTH ? `${id.slice(0, ID_PREFIX_LENGTH)}…` : id

// Money classes store minor units (cents / USDT micros); embeds should show
// display units ($95.40, not 9540).
export const toDisplayAmount = (
  amount: USDAmount | USDTAmount | JMDAmount,
): { value: string; currency: string } => ({
  value: amount instanceof USDTAmount ? amount.asNumber(2) : amount.asDollars(),
  currency: amount.currencyCode,
})

const envLabel = (): string => NETWORK ?? process.env.NODE_ENV ?? "unknown"

const titleCase = (phrase: string): string =>
  phrase
    .split("-")
    .map((word) => (word === "otp" ? "OTP" : word))
    .join(" ")

export const buildEmbed = (event: OpsEvent): DiscordEmbed => {
  const flowTitle = event.flow[0].toUpperCase() + event.flow.slice(1)
  const fields: DiscordEmbedField[] = []
  const field = makeFieldBuilder(fields)

  field("account", event.accountId && truncateId(event.accountId))
  field("user", event.userId && truncateId(event.userId))
  field("device", event.deviceId && truncateId(event.deviceId))
  field("phone", event.phone && maskPhone(event.phone))
  field("email", event.email && maskEmail(event.email))
  if (event.amount) {
    field("amount", `${event.amount.value} ${event.amount.currency}`)
  }
  field("step", event.step)
  field("error", event.error)
  for (const [key, value] of Object.entries(event.meta ?? {})) {
    if (typeof value === "string" && value) field(key, truncateId(value))
  }
  field("env", envLabel())

  return {
    title: `${FLOW_EMOJI[event.flow]} ${flowTitle} — ${titleCase(event.phase)}`,
    color: EMBED_COLOR[event.status],
    fields,
    timestamp: new Date().toISOString(),
  }
}

const droppedSummaryEmbed = (dropped: number): DiscordEmbed => ({
  title: `⚠️ Ops events — ${dropped} event${dropped === 1 ? "" : "s"} dropped`,
  color: EMBED_COLOR.failed,
  fields: [{ name: "env", value: envLabel(), inline: true }],
  timestamp: new Date().toISOString(),
})

// --- Delivery queue ---

const queue: OpsEvent[] = []
let droppedCount = 0
let draining: Promise<void> | undefined

// Deliver via the shared, rate-limit-aware sender. It clamps to Discord's
// aggregate limit and honors a 429's retry_after once; FETCH_TIMEOUT_MS keeps
// the ops feed's tighter 3s timeout.
const send = (embed: DiscordEmbed): Promise<void> =>
  postEmbed(OPS_DISCORD_WEBHOOK_URL as string, embed, FETCH_TIMEOUT_MS)

const drain = async (): Promise<void> => {
  try {
    while (queue.length > 0) {
      const event = queue.shift()
      if (event) await send(buildEmbed(event))

      if (queue.length === 0 && droppedCount > 0) {
        const dropped = droppedCount
        droppedCount = 0
        await send(droppedSummaryEmbed(dropped))
      }
    }
  } catch (error) {
    recordExceptionInCurrentSpan({ error, level: ErrorLevel.Warn })
  }
}

/**
 * Enqueue an ops event for fire-and-forget delivery. Returns immediately and
 * never throws; delivery happens sequentially in the background.
 */
export const notifyOpsEvent = (event: OpsEvent): void => {
  if (!OPS_DISCORD_WEBHOOK_URL) return

  queue.push(event)
  if (queue.length > MAX_QUEUE) {
    queue.shift()
    droppedCount += 1
  }

  if (!draining) {
    draining = drain().finally(() => {
      draining = undefined
    })
  }
}

/**
 * Resolves once the delivery queue is idle.
 *
 * This is the drain barrier for graceful shutdown as well as for tests: the
 * SIGTERM handler in src/app/authentication/request-code.ts races it against a
 * bounded timeout so the coalesced blocked-destination summaries actually reach
 * Discord before the pod exits. It must keep returning the in-flight `draining`
 * promise — resolving eagerly would silently turn that flush into a no-op.
 */
export const opsEventsSettled = (): Promise<void> => draining ?? Promise.resolve()
