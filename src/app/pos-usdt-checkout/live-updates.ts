import { createHash, randomUUID, timingSafeEqual } from "crypto"

import type { UsdtCheckoutStatus } from "./checkout"

/**
 * iOS Live Activity updates for one public POS USDT checkout, sent by APNs.
 *
 * Receive-only and outside the money path. Nothing in here writes a
 * checkout row or a credit, or calls IBEX. Progress comes only from
 * `Dependencies.checkout.status`, owned by the checkout service (in Flash it
 * is `followedStatus`, the same verified, throttled read-back the POS's own
 * status poll runs). A failure here (store, vault, APNs) never changes what a
 * sale is paid, and a device can never tell this code what stage it is in.
 *
 * A device opts in per receipt. The request proves it holds the receipt
 * capability (the same opaque id `posUsdtCheckoutStatus` takes) and the
 * domain-separated sale key the app computed for the endpoint it uses:
 *
 *   saleKey = SHA-256("flash.pos.usdt-flight.v1\n" + endpoint + "\n" + receiptId)
 *
 * and names one Live Activity (ActivityKit `Activity.id`) with its current
 * push token. The caller never sends a milestone: the stage is always the
 * checkout's real status.
 *
 * The outbox sends, per device, at most four pushes in this order, each at
 * least MIN_GAP_MS after the previous one, with strictly increasing APNs
 * timestamps:
 *
 *   rank 0  DETECTED folded      rank 2  PAID folded
 *   rank 1  DETECTED lifted      rank 3  PAID lifted  (event "end", terminal)
 *
 * Only the poses of the stage the checkout is in now are sent: a sale first
 * seen PAID goes straight to rank 2. A rank is never sent twice once APNs
 * accepted it, and never goes backwards.
 */

export const SALE_KEY_DOMAIN = "flash.pos.usdt-flight.v1"
const SLOT_DOMAIN = "flash.pos.usdt-live.slot.v1"
const TOKEN_DIGEST_DOMAIN = "flash.pos.usdt-live.token-digest.v1"
const TOKEN_AAD_DOMAIN = "flash.pos.usdt-live.token.v1"

// Devices that may follow one receipt at the same time.
export const MAX_LIVE_DEVICES = 2
// Activities ever recorded for one receipt, withdrawn ones included. Bounds
// a churn of new activity ids from a holder of the receipt.
export const MAX_SLOTS = 4
export const MIN_GAP_MS = 2_000
export const POLL_MS = 3_000
export const MAX_ATTEMPTS = 8
// Kept after the follow window ends so a replayed or delayed request cannot
// restart a receipt that already ended. Purged by a TTL index afterwards.
export const RETAIN_MS = 24 * 60 * 60 * 1000
export const DEFAULT_FOLLOW_MS = 60 * 60 * 1000
// ActivityKit ends an activity after 8 hours.
export const MAX_FOLLOW_MS = 8 * 60 * 60 * 1000
// Seconds APNs may hold a push for an offline device.
export const APNS_EXPIRATION_S = 180
export const DISMISS_AFTER_S = 300
export const LEASE_MS = 60_000

const hex64 = /^[0-9a-f]{64}$/
// Hex as ActivityKit's pushToken Data is exported: 16 to 512 bytes, lowercase.
export const PUSH_TOKEN = /^(?:[0-9a-f]{2}){16,512}$/
// ActivityKit Activity.id: a UUID string.
const ACTIVITY_ID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
const MAX_SEQUENCE = 2_147_483_647

const sha = (v: string) => createHash("sha256").update(v).digest("hex")

export function saleKeyFor(endpoint: string, receiptId: string) {
  return sha(SALE_KEY_DOMAIN + "\n" + endpoint + "\n" + receiptId)
}

const slotIdFor = (checkoutKey: string, activityId: string) =>
  sha(SLOT_DOMAIN + "\n" + checkoutKey + "\n" + activityId.toUpperCase())

const tokenDigest = (checkoutKey: string, token: string) =>
  sha(TOKEN_DIGEST_DOMAIN + "\n" + checkoutKey + "\n" + token)

// Binds a sealed token to its receipt and activity: it cannot be moved.
export const tokenAad = (checkoutKey: string, slotId: string) =>
  TOKEN_AAD_DOMAIN + "\n" + checkoutKey + "\n" + slotId

const sameHex = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export type SlotState = "ACTIVE" | "DONE" | "REVOKED" | "FAILED" | "WITHDRAWN"

export type Slot = {
  // Digest of the receipt's checkout key and the activity id.
  id: string
  // Highest client sequence applied (enroll, rotation or withdrawal).
  seq: number
  state: SlotState
  // The push token, sealed by the vault. Only while ACTIVE.
  sealed?: string
  tokenDigest?: string
  // Highest rank APNs accepted, -1 before the first.
  sentRank: number
  // Last APNs timestamp (seconds) handed out for this slot, accepted or not.
  lastTimestamp: number
  lastSentAt?: number
  attempts: number
  nextAt: number
}

export type LiveDoc = {
  // The checkout key: sha256 of the receipt id, the checkout row's _id.
  _id: string
  // Optimistic concurrency; 0 for a document not stored yet.
  version: number
  createdAt: number
  followUntil: number
  expiresAt: number
  // Highest stage seen: -1 awaiting, 0 detected, 1 paid.
  stage: number
  slots: Slot[]
  slotsCreated: number
  nextAt: number
  done: boolean
}

export type LiveStore = {
  load(key: string): Promise<LiveDoc | null>
  // Inserts when doc.version is 0, else replaces the stored doc only if its
  // version still equals doc.version. False on a lost race. Never touches
  // the lease.
  save(doc: LiveDoc): Promise<boolean>
  // Leases up to `limit` docs that are not done and are due.
  claimDue(now: number, lease: string, leaseMs: number, limit: number): Promise<string[]>
  release(key: string, lease: string): Promise<void>
}

export type Vault = {
  seal(plain: string, aad: string): string
  open(sealed: string, aad: string): string
}

export type LivePush = {
  timestamp: number
  stage: 0 | 1
  folded: boolean
  end: boolean
}

export type PushResult =
  | { kind: "ok" }
  // The token will never work again (unregistered, wrong topic, malformed).
  | { kind: "gone"; reason: string }
  // Try again later.
  | { kind: "retry"; reason: string; retryAfterMs?: number }
  // The provider credential is refused: not this device's fault.
  | { kind: "auth"; reason: string }
  // APNs refused this push as built. Retrying would repeat it.
  | { kind: "refused"; reason: string }

export type Transport = {
  // Must not throw; a throw is treated as a retry.
  send(token: string, push: LivePush): Promise<PushResult>
}

export type Dependencies = {
  store: LiveStore
  // The checkout's real status, null when there is no published checkout for
  // this key. Owned by the checkout service; this module only reads it.
  checkout: { status(key: string): Promise<UsdtCheckoutStatus | null> }
  // Endpoints the app may have hashed into a sale key, exactly as it hashed them.
  scopes: string[]
  vault: Vault
  limitIp(ip: string): Promise<void>
  limitReceipt(checkoutKey: string): Promise<void>
  now(): number
  followMs?: number
  // Never given a token, sealed token, receipt id, sale key or credential.
  report(event: string, detail: Record<string, unknown>): void
}

export class LiveUpdateError extends Error {}
const unknownCheckout = () => new LiveUpdateError("Unknown checkout.")
const invalid = () => new LiveUpdateError("Invalid live update request.")

export type ConsentInput = {
  action: "ENROLL" | "WITHDRAW"
  receiptId: string
  saleKey: string
  activityId: string
  tokenSequence: number
  pushToken?: string | null
}

export type ConsentResult =
  | "enrolled"
  | "rotated"
  | "duplicate"
  | "stale"
  | "withdrawn"
  | "finished"

type Refusal = "full" | "paid" | "ended" | "conflict"
const refusals: Record<Refusal, string> = {
  full: "This checkout is already followed by the maximum number of devices.",
  paid: "This checkout is already paid.",
  ended: "Live updates have ended for this checkout.",
  conflict: "This live update request conflicts with an earlier one.",
}

export const stageOf = (status: UsdtCheckoutStatus) =>
  status === "PAID" ? 1 : status === "DETECTED" ? 0 : -1

/** The next rank to send a slot for this stage, if any. */
export function nextRank(sentRank: number, stage: number): number | undefined {
  if (stage < 0) return undefined
  const fold = stage * 2
  if (sentRank < fold) return fold
  if (sentRank < fold + 1) return fold + 1
  return undefined
}

export function pushFor(rank: number, timestamp: number): LivePush {
  const stage = rank >= 2 ? 1 : 0
  const folded = rank % 2 === 0
  return { timestamp, stage, folded, end: stage === 1 && !folded }
}

/** The ActivityKit payload. Carries no receipt, amount, wallet or address. */
export function livePayload(push: LivePush) {
  const aps: Record<string, unknown> = {
    "timestamp": push.timestamp,
    "event": push.end ? "end" : "update",
    "content-state": {
      stage: push.stage,
      cents: 0,
      folded: push.folded,
      singleStroke: false,
    },
  }
  if (push.end) aps["dismissal-date"] = push.timestamp + DISMISS_AFTER_S
  return { aps }
}

export const backoffMs = (attempts: number) =>
  Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1))

const wipe = (slot: Slot) => {
  delete slot.sealed
  delete slot.tokenDigest
}
const live = (doc: LiveDoc) => doc.slots.filter((s) => s.state === "ACTIVE")
const clone = (doc: LiveDoc): LiveDoc => ({
  ...doc,
  slots: doc.slots.map((s) => ({ ...s })),
})
const short = (key: string) => key.slice(0, 12)

function finish(doc: LiveDoc, now: number) {
  doc.done = true
  for (const slot of doc.slots) {
    if (slot.state === "ACTIVE") slot.state = "FAILED"
    wipe(slot)
  }
  doc.expiresAt = Math.min(doc.expiresAt, now + RETAIN_MS)
  doc.nextAt = doc.expiresAt
}

// When the doc should be looked at again.
function schedule(doc: LiveDoc, now: number) {
  if (doc.done) return
  const active = live(doc)
  if (!active.length) {
    // Nobody to tell. A paid receipt is over; otherwise a new opt-in wakes it.
    if (doc.stage >= 1) finish(doc, now)
    else doc.nextAt = doc.followUntil
    return
  }
  let next = now + POLL_MS
  for (const slot of active) {
    // Waiting out a backoff or the gap before the next pose.
    if (slot.nextAt > now) next = Math.min(next, slot.nextAt)
    else if (nextRank(slot.sentRank, doc.stage) !== undefined) next = now
  }
  doc.nextAt = Math.min(Math.max(next, now), doc.followUntil)
}

export function liveUpdateService(d: Dependencies) {
  const followMs = Math.min(d.followMs ?? DEFAULT_FOLLOW_MS, MAX_FOLLOW_MS)

  // Load, change and store one doc, retrying a lost race.
  async function mutate<T>(
    key: string,
    change: (doc: LiveDoc | null) => { doc?: LiveDoc; value: T },
  ): Promise<T> {
    for (let i = 0; i < 5; i++) {
      const loaded = await d.store.load(key)
      const { doc, value } = change(loaded ? clone(loaded) : null)
      if (!doc || (await d.store.save(doc))) return value
    }
    throw new LiveUpdateError("Live updates are busy. Retry in a moment.")
  }

  function fresh(key: string, now: number): LiveDoc {
    const followUntil = now + followMs
    return {
      _id: key,
      version: 0,
      createdAt: now,
      followUntil,
      expiresAt: followUntil + RETAIN_MS,
      stage: -1,
      slots: [],
      slotsCreated: 0,
      nextAt: now,
      done: false,
    }
  }

  async function consent(raw: ConsentInput, ip: string): Promise<ConsentResult> {
    await d.limitIp(ip)
    const input = (raw ?? {}) as Partial<ConsentInput>
    const { action, receiptId, saleKey, activityId, pushToken } = input
    const tokenSequence = input.tokenSequence as number
    if (
      typeof receiptId !== "string" ||
      !hex64.test(receiptId) ||
      typeof saleKey !== "string" ||
      !hex64.test(saleKey)
    )
      throw unknownCheckout()
    if (
      (action !== "ENROLL" && action !== "WITHDRAW") ||
      typeof activityId !== "string" ||
      !ACTIVITY_ID.test(activityId) ||
      !Number.isSafeInteger(tokenSequence) ||
      tokenSequence < 1 ||
      tokenSequence > MAX_SEQUENCE
    )
      throw invalid()
    if (
      action === "ENROLL" &&
      (typeof pushToken !== "string" || !PUSH_TOKEN.test(pushToken))
    )
      throw invalid()
    if (action === "WITHDRAW" && pushToken !== undefined && pushToken !== null)
      throw invalid()

    const key = sha(receiptId)
    const status = await d.checkout.status(key)
    // Unknown receipt, other environment and wrong key look the same.
    if (!status || !d.scopes.some((s) => sameHex(saleKeyFor(s, receiptId), saleKey)))
      throw unknownCheckout()
    await d.limitReceipt(key)

    const slotId = slotIdFor(key, activityId)
    const aad = tokenAad(key, slotId)
    const digest = action === "ENROLL" ? tokenDigest(key, pushToken as string) : undefined
    const now = d.now()

    const outcome = await mutate<ConsentResult | Refusal>(key, (loaded) => {
      const doc = loaded ?? fresh(key, now)
      // Nothing is held for an ended receipt, so a withdrawal is already true.
      if (doc.done || now >= doc.followUntil)
        return { value: action === "WITHDRAW" ? "withdrawn" : "ended" }
      const slot = doc.slots.find((s) => s.id === slotId)
      const activeOthers = live(doc).filter((s) => s.id !== slotId).length

      if (action === "WITHDRAW") {
        if (!slot) {
          // Recorded, so a delayed enroll with a lower sequence stays out.
          if (doc.slots.length >= MAX_SLOTS) return { value: "withdrawn" }
          doc.slots.push({
            id: slotId,
            seq: tokenSequence,
            state: "WITHDRAWN",
            sentRank: -1,
            lastTimestamp: 0,
            attempts: 0,
            nextAt: now,
          })
          doc.slotsCreated += 1
        } else {
          if (tokenSequence <= slot.seq) return { value: "stale" }
          slot.seq = tokenSequence
          if (slot.state !== "DONE") slot.state = "WITHDRAWN"
          wipe(slot)
        }
        schedule(doc, now)
        return { doc, value: "withdrawn" }
      }

      const token = pushToken as string
      if (!slot) {
        if (status === "PAID") return { value: "paid" }
        if (activeOthers >= MAX_LIVE_DEVICES || doc.slots.length >= MAX_SLOTS)
          return { value: "full" }
        doc.slots.push({
          id: slotId,
          seq: tokenSequence,
          state: "ACTIVE",
          sealed: d.vault.seal(token, aad),
          tokenDigest: digest,
          sentRank: -1,
          lastTimestamp: 0,
          attempts: 0,
          nextAt: now,
        })
        doc.slotsCreated += 1
        doc.nextAt = now
        return { doc, value: "enrolled" }
      }
      if (tokenSequence < slot.seq) return { value: "stale" }
      if (tokenSequence === slot.seq) {
        // A repeat of the request that set this sequence, or a different one.
        if (slot.state === "DONE") return { value: "finished" }
        if (slot.state === "ACTIVE" && slot.tokenDigest === digest)
          return { value: "duplicate" }
        return { value: "conflict" }
      }
      if (slot.state === "DONE") return { value: "finished" }
      if (slot.state !== "ACTIVE" && activeOthers >= MAX_LIVE_DEVICES)
        return { value: "full" }
      // A rotated token, or a new opt-in after a withdrawal or a dead token.
      const wasActive = slot.state === "ACTIVE"
      slot.seq = tokenSequence
      slot.state = "ACTIVE"
      slot.sealed = d.vault.seal(token, aad)
      slot.tokenDigest = digest
      slot.attempts = 0
      slot.nextAt = Math.max(now, (slot.lastSentAt ?? 0) + MIN_GAP_MS)
      schedule(doc, now)
      // An enrollment wakes a receipt which may have been sleeping with no devices.
      doc.nextAt = now
      return { doc, value: wasActive ? "rotated" : "enrolled" }
    })

    if (outcome in refusals) {
      throw new LiveUpdateError(refusals[outcome as Refusal])
    }
    return outcome as ConsentResult
  }

  type Reservation = {
    slotId: string
    seq: number
    rank: number
    timestamp: number
    sealed: string
  }

  // Hands out the next push of one slot, with its timestamp stored first.
  async function reserve(key: string, slotId: string, now: number) {
    return mutate<Reservation | undefined>(key, (doc) => {
      if (!doc || doc.done) return { value: undefined }
      const slot = doc.slots.find((s) => s.id === slotId)
      if (!slot || slot.state !== "ACTIVE" || !slot.sealed || slot.nextAt > now)
        return { value: undefined }
      const rank = nextRank(slot.sentRank, doc.stage)
      if (rank === undefined) return { value: undefined }
      const timestamp = Math.max(Math.floor(now / 1000), slot.lastTimestamp + 1)
      slot.lastTimestamp = timestamp
      return {
        doc,
        value: { slotId, seq: slot.seq, rank, timestamp, sealed: slot.sealed },
      }
    })
  }

  async function settle(key: string, r: Reservation, result: PushResult, now: number) {
    await mutate<void>(key, (doc) => {
      const slot = doc?.slots.find((s) => s.id === r.slotId)
      // Rotated or withdrawn meanwhile: the new token gets its own push.
      if (!doc || !slot || slot.seq !== r.seq || slot.state !== "ACTIVE")
        return { value: undefined }
      switch (result.kind) {
        case "ok":
          slot.sentRank = Math.max(slot.sentRank, r.rank)
          slot.lastSentAt = now
          slot.attempts = 0
          slot.nextAt = now + MIN_GAP_MS
          if (slot.sentRank >= 3) {
            slot.state = "DONE"
            wipe(slot)
          }
          break
        case "gone":
          slot.state = "REVOKED"
          wipe(slot)
          break
        case "refused":
          slot.state = "FAILED"
          wipe(slot)
          break
        case "retry":
        case "auth":
          slot.attempts += 1
          if (slot.attempts >= MAX_ATTEMPTS) {
            slot.state = "FAILED"
            wipe(slot)
          } else {
            const asked = result.kind === "retry" ? (result.retryAfterMs ?? 0) : 0
            slot.nextAt =
              now + Math.max(backoffMs(slot.attempts), Math.min(asked, 60_000))
          }
          break
      }
      schedule(doc, now)
      return { doc, value: undefined }
    })
  }

  async function markUnreadable(key: string, r: Reservation, now: number) {
    await mutate<void>(key, (doc) => {
      const slot = doc?.slots.find((s) => s.id === r.slotId)
      if (!doc || !slot || slot.seq !== r.seq) return { value: undefined }
      slot.state = "FAILED"
      wipe(slot)
      schedule(doc, now)
      return { doc, value: undefined }
    })
  }

  type FollowSummary = { pushed: number; failed: number; finished: boolean }

  /** One look at one claimed receipt. Never throws for a device's failure. */
  async function follow(key: string, transport: Transport): Promise<FollowSummary> {
    const summary: FollowSummary = { pushed: 0, failed: 0, finished: false }
    const now = d.now()
    const doc = await d.store.load(key)
    if (!doc || doc.done) return summary

    let status: UsdtCheckoutStatus | null
    try {
      status = now >= doc.followUntil ? null : await d.checkout.status(key)
    } catch {
      // The checkout could not be read: look again later, change nothing.
      await mutate<void>(key, (current) => {
        if (!current || current.done) return { value: undefined }
        current.nextAt = now + POLL_MS
        return { doc: current, value: undefined }
      })
      d.report("live_status_unreadable", { checkout: short(key) })
      return summary
    }

    // Record the stage (never lower), or end the receipt.
    const plan = await mutate<string[]>(key, (current) => {
      if (!current || current.done) return { value: [] }
      if (!status) {
        finish(current, now)
        return { doc: current, value: [] }
      }
      current.stage = Math.max(current.stage, stageOf(status))
      schedule(current, now)
      if (current.done) return { doc: current, value: [] }
      const due = live(current)
        .filter(
          (s) => s.nextAt <= now && nextRank(s.sentRank, current.stage) !== undefined,
        )
        .map((s) => s.id)
      return { doc: current, value: due }
    })
    if (!status) {
      summary.finished = true
      return summary
    }

    for (const slotId of plan) {
      const r = await reserve(key, slotId, now)
      if (!r) continue
      let token: string
      try {
        token = d.vault.open(r.sealed, tokenAad(key, slotId))
        if (!PUSH_TOKEN.test(token)) throw new Error("malformed")
      } catch {
        d.report("live_token_unreadable", { checkout: short(key), slot: short(slotId) })
        await markUnreadable(key, r, now)
        summary.failed += 1
        continue
      }
      let result: PushResult
      try {
        result = await transport.send(token, pushFor(r.rank, r.timestamp))
      } catch {
        result = { kind: "retry", reason: "transport" }
      }
      if (result.kind === "ok") summary.pushed += 1
      else {
        summary.failed += 1
        d.report("live_push_not_accepted", {
          checkout: short(key),
          slot: short(slotId),
          rank: r.rank,
          kind: result.kind,
          reason: result.reason,
        })
      }
      await settle(key, r, result, d.now())
    }
    const after = await d.store.load(key)
    summary.finished = !!after?.done
    return summary
  }

  return {
    consent,

    /**
     * One worker pass: lease due receipts, follow each. Errors are contained
     * per receipt; the lease runs out on its own if this process dies.
     */
    async runDue(transport: Transport, limit = 25) {
      const lease = randomUUID()
      // Longer than two sends at the transport's 15 s timeout.
      const keys = await d.store.claimDue(d.now(), lease, LEASE_MS, limit)
      const totals = {
        receipts: keys.length,
        pushed: 0,
        failed: 0,
        finished: 0,
        errors: 0,
      }
      await Promise.all(
        keys.map(async (key) => {
          try {
            const s = await follow(key, transport)
            totals.pushed += s.pushed
            totals.failed += s.failed
            if (s.finished) totals.finished += 1
          } catch {
            totals.errors += 1
            d.report("live_follow_error", { checkout: short(key) })
          } finally {
            await d.store.release(key, lease).catch(() => undefined)
          }
        }),
      )
      return totals
    },
  }
}

export type LiveUpdateService = ReturnType<typeof liveUpdateService>
