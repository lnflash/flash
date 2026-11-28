import { createHash, randomBytes } from "crypto"

import { UsdtCheckoutStatus } from "@app/pos-usdt-checkout/checkout"
import {
  ConsentInput,
  Dependencies,
  LiveDoc,
  LivePush,
  livePayload,
  LiveStore,
  liveUpdateService,
  MAX_ATTEMPTS,
  pushFor,
  PushResult,
  saleKeyFor,
  Transport,
} from "@app/pos-usdt-checkout/live-updates"
import { parseKeyring, tokenVault } from "@services/pos-usdt-checkout/token-vault"

const sha = (v: string) => createHash("sha256").update(v).digest("hex")
const SCOPE = "https://api.test.flashapp.me/graphql"
const RECEIPT = sha("receipt-1")
const KEY = sha(RECEIPT)
const OTHER_RECEIPT = sha("receipt-2")
const IP = "192.0.2.15"
const saleKey = (receipt = RECEIPT, scope = SCOPE) =>
  sha("flash.pos.usdt-flight.v1\n" + scope + "\n" + receipt)
const activity = (n: number) => `6A1F3C2E-0B4D-4E5F-8A9B-${String(n).padStart(12, "0")}`
const token = (n: number) => n.toString(16).padStart(2, "0").repeat(32)

// The Mongo store's versioned replace and lease, in memory.
function memoryStore() {
  type Held = LiveDoc & { lease?: string; leaseUntil?: number }
  const docs = new Map<string, Held>()
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v))
  const store: LiveStore = {
    async load(k) {
      const d = docs.get(k)
      if (!d) return null
      const out = copy(d)
      delete out.lease
      delete out.leaseUntil
      return out
    },
    async save(doc) {
      const cur = docs.get(doc._id)
      if (doc.version === 0) {
        if (cur) return false
        docs.set(doc._id, { ...copy(doc), version: 1 })
        return true
      }
      if (!cur || cur.version !== doc.version) return false
      docs.set(doc._id, {
        ...copy(doc),
        version: doc.version + 1,
        lease: cur.lease,
        leaseUntil: cur.leaseUntil,
      })
      return true
    },
    async claimDue(now, lease, leaseMs, limit) {
      const out: string[] = []
      for (const d of [...docs.values()].sort((a, b) => a.nextAt - b.nextAt)) {
        if (out.length >= limit) break
        if (d.done || d.nextAt > now) continue
        if (d.leaseUntil !== undefined && d.leaseUntil >= now) continue
        d.lease = lease
        d.leaseUntil = now + leaseMs
        out.push(d._id)
      }
      return out
    },
    async release(k, lease) {
      const d = docs.get(k)
      if (d && d.lease === lease) {
        delete d.lease
        delete d.leaseUntil
      }
    },
  }
  return { store, docs }
}

type Sent = { token: string; push: LivePush; at: number }

function setup() {
  let t = 1_800_000_000_000
  const { store, docs } = memoryStore()
  const statuses = new Map<string, UsdtCheckoutStatus>([
    [KEY, "AWAITING_PAYMENT"],
    [sha(OTHER_RECEIPT), "AWAITING_PAYMENT"],
  ])
  const sent: Sent[] = []
  const results: PushResult[] = []
  const reports: { event: string; detail: Record<string, unknown> }[] = []
  const transport: Transport & { send: jest.Mock } = {
    send: jest.fn(async (tok: string, push: LivePush): Promise<PushResult> => {
      sent.push({ token: tok, push, at: t })
      return results.shift() ?? { kind: "ok" }
    }),
  }
  const deps: Dependencies = {
    store,
    checkout: { status: jest.fn(async (k: string) => statuses.get(k) ?? null) },
    scopes: [SCOPE],
    vault: tokenVault(parseKeyring("k1:" + randomBytes(32).toString("base64"))),
    limitIp: jest.fn(async () => undefined),
    limitReceipt: jest.fn(async () => undefined),
    now: () => t,
    report: (event, detail) => reports.push({ event, detail }),
  }
  const service = liveUpdateService(deps)
  const consent = (o: Partial<ConsentInput>) =>
    service.consent(
      {
        action: "ENROLL",
        receiptId: RECEIPT,
        saleKey: saleKey(),
        activityId: activity(1),
        tokenSequence: 1,
        pushToken: token(1),
        ...o,
      } as ConsentInput,
      IP,
    )
  return {
    deps,
    docs,
    sent,
    results,
    reports,
    transport,
    service,
    statuses,
    consent,
    enroll: (a: number, tok: number, seq = 1) =>
      consent({ activityId: activity(a), pushToken: token(tok), tokenSequence: seq }),
    withdraw: (a: number, seq: number) =>
      consent({
        action: "WITHDRAW",
        activityId: activity(a),
        tokenSequence: seq,
        pushToken: undefined,
      }),
    advance: (ms: number) => {
      t += ms
    },
    tick: () => service.runDue(transport),
    now: () => t,
  }
}
type Env = ReturnType<typeof setup>

// Lets the worker run for `ms`, a pass every 250 ms.
async function run(env: Env, ms: number) {
  for (let i = 0; i < ms; i += 250) {
    await env.tick()
    env.advance(250)
  }
}
const ranks = (sent: Sent[]) =>
  sent.map((s) => s.push.stage * 2 + (s.push.folded ? 0 : 1))
const slot = (env: Env, n = 0) => env.docs.get(KEY)!.slots[n]

describe("the sale key", () => {
  it("is the native app's and the private observer's formula", () => {
    expect(saleKeyFor(SCOPE, RECEIPT)).toBe(saleKey())
    const observer = "http://register.local:18588/simulation"
    expect(saleKeyFor(observer, RECEIPT)).toBe(
      createHash("sha256")
        .update("flash.pos.usdt-flight.v1\n" + observer + "\n" + RECEIPT)
        .digest("hex"),
    )
  })
})

describe("opting in", () => {
  it("answers an unknown receipt, another receipt's key and another endpoint's key alike", async () => {
    const env = setup()
    for (const o of [
      { receiptId: sha("never-created"), saleKey: saleKey(sha("never-created")) },
      { saleKey: saleKey(OTHER_RECEIPT) },
      { saleKey: saleKey(RECEIPT, "https://api.flashapp.me/graphql") },
      { saleKey: saleKey().toUpperCase() },
      { receiptId: "not-a-receipt" },
    ])
      await expect(env.consent(o)).rejects.toThrow("Unknown checkout.")
    expect(env.docs.size).toBe(0)
    // Charged per IP every time; per receipt only once the receipt is proven.
    expect(env.deps.limitIp).toHaveBeenCalledTimes(5)
    expect(env.deps.limitReceipt).not.toHaveBeenCalled()
  })

  it.each([
    ["an activity id that is not a UUID", { activityId: "activity-1" }],
    ["an uppercase token", { pushToken: token(171).toUpperCase() }],
    ["a short token", { pushToken: "ab".repeat(15) }],
    ["an odd-length token", { pushToken: token(1) + "a" }],
    ["no token", { pushToken: undefined }],
    ["sequence 0", { tokenSequence: 0 }],
    ["a fractional sequence", { tokenSequence: 1.5 }],
    ["an unknown action", { action: "PAID" as never }],
    ["a token on a withdrawal", { action: "WITHDRAW" as const }],
  ])("refuses %s, without touching the checkout", async (_label, o) => {
    const env = setup()
    await expect(env.consent(o)).rejects.toThrow("Invalid live update request.")
    expect(env.deps.checkout.status).not.toHaveBeenCalled()
    expect(env.docs.size).toBe(0)
  })

  it("stops at the IP limit before reading anything", async () => {
    const env = setup()
    ;(env.deps.limitIp as jest.Mock).mockRejectedValueOnce(new Error("limited"))
    await expect(env.enroll(1, 1)).rejects.toThrow("limited")
    expect(env.deps.checkout.status).not.toHaveBeenCalled()
  })

  it("stores the token sealed and bound to its receipt and activity", async () => {
    const env = setup()
    expect(await env.enroll(1, 1)).toBe("enrolled")
    const stored = JSON.stringify([...env.docs.values()])
    for (const secret of [token(1), RECEIPT, saleKey()])
      expect(stored).not.toContain(secret)
    const s = slot(env)
    expect(s.sealed).toMatch(/^v1\.k1\./)
    // The same ciphertext under another receipt or activity does not open.
    expect(() => env.deps.vault.open(s.sealed!, "elsewhere")).toThrow()
  })

  it("never takes a milestone from the caller", async () => {
    const env = setup()
    await env.consent({ status: "PAID", stage: 1, folded: false } as never)
    await run(env, 10_000)
    expect(env.sent).toEqual([])
  })

  it("refuses a new device once the checkout is paid", async () => {
    const env = setup()
    env.statuses.set(KEY, "PAID")
    await expect(env.enroll(1, 1)).rejects.toThrow("already paid")
  })

  it("follows at most two devices, and a bounded number of activities ever", async () => {
    const env = setup()
    expect(await env.enroll(1, 1)).toBe("enrolled")
    expect(await env.enroll(2, 2)).toBe("enrolled")
    await expect(env.enroll(3, 3)).rejects.toThrow("maximum number of devices")
    expect(await env.withdraw(2, 2)).toBe("withdrawn")
    expect(await env.enroll(3, 3)).toBe("enrolled")
    expect(await env.withdraw(3, 2)).toBe("withdrawn")
    expect(await env.enroll(4, 4)).toBe("enrolled")
    expect(await env.withdraw(4, 2)).toBe("withdrawn")
    // Four activities recorded: a fifth is refused even with a free device slot.
    await expect(env.enroll(5, 5)).rejects.toThrow("maximum number of devices")

    env.statuses.set(KEY, "DETECTED")
    env.advance(3_000)
    await env.tick()
    // Only the device still opted in, and the withdrawn tokens are gone.
    expect(env.sent.map((s) => s.token)).toEqual([token(1)])
    expect(env.docs.get(KEY)!.slots.filter((s) => s.sealed)).toHaveLength(1)
  })

  it("sends both devices every pose", async () => {
    const env = setup()
    await env.enroll(1, 1)
    await env.enroll(2, 2)
    env.statuses.set(KEY, "PAID")
    await run(env, 6_000)
    for (const t of [token(1), token(2)])
      expect(ranks(env.sent.filter((s) => s.token === t))).toEqual([2, 3])
  })
})

describe("the outbox", () => {
  it("sends DETECTED then PAID, folded then lifted, 2 s apart, ending only on the lifted PAID", async () => {
    const env = setup()
    await env.enroll(1, 1)
    await run(env, 5_000)
    expect(env.sent).toEqual([])

    env.statuses.set(KEY, "DETECTED")
    await run(env, 5_000)
    expect(ranks(env.sent)).toEqual([0, 1])
    env.statuses.set(KEY, "PAID")
    await run(env, 10_000)
    expect(ranks(env.sent)).toEqual([0, 1, 2, 3])

    const gaps = env.sent.slice(1).map((s, i) => s.at - env.sent[i].at)
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(2_000)
    const stamps = env.sent.map((s) => s.push.timestamp)
    for (let i = 1; i < stamps.length; i++)
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1])
    expect(env.sent.map((s) => s.push.end)).toEqual([false, false, false, true])

    // Done: the token is wiped and nothing more is sent.
    const doc = env.docs.get(KEY)!
    expect(doc.done).toBe(true)
    expect(doc.slots[0]).toMatchObject({ state: "DONE", sentRank: 3 })
    expect(doc.slots[0].sealed).toBeUndefined()
    await run(env, 10_000)
    expect(env.sent).toHaveLength(4)
    await expect(env.enroll(1, 1, 2)).rejects.toThrow("ended")
  })

  it("goes straight to the PAID poses for a sale first seen paid", async () => {
    const env = setup()
    await env.enroll(1, 1)
    env.statuses.set(KEY, "PAID")
    await run(env, 6_000)
    expect(ranks(env.sent)).toEqual([2, 3])
  })

  it("builds exactly the payload the private relay sends, and nothing about the sale", () => {
    const now = 1_800_000_000
    // apple-relay.cjs, for a stage and a pose.
    const relay = (stage: number, folded: boolean) => {
      const aps: Record<string, unknown> = {
        "timestamp": now,
        "event": stage === 1 && !folded ? "end" : "update",
        "content-state": { stage, cents: 0, folded, singleStroke: false },
      }
      if (stage === 1 && !folded) aps["dismissal-date"] = now + 300
      return { aps }
    }
    expect(livePayload(pushFor(0, now))).toEqual(relay(0, true))
    expect(livePayload(pushFor(1, now))).toEqual(relay(0, false))
    expect(livePayload(pushFor(2, now))).toEqual(relay(1, true))
    expect(livePayload(pushFor(3, now))).toEqual(relay(1, false))
  })

  it("follows a rotated token, and ignores a delayed older one", async () => {
    const env = setup()
    await env.enroll(1, 1, 1)
    env.statuses.set(KEY, "DETECTED")
    await env.tick()
    expect(await env.enroll(1, 2, 2)).toBe("rotated")
    // The first rotation request arriving late, and a repeat of the latest.
    expect(await env.enroll(1, 1, 1)).toBe("stale")
    expect(await env.enroll(1, 2, 2)).toBe("duplicate")
    await expect(env.enroll(1, 3, 2)).rejects.toThrow("conflicts")
    await run(env, 3_000)
    expect(env.sent.map((s) => [s.token, ranks([s])[0]])).toEqual([
      [token(1), 0],
      [token(2), 1],
    ])
  })

  it("resends to the new token when a rotation lands while a push is in flight", async () => {
    const env = setup()
    await env.enroll(1, 1, 1)
    env.statuses.set(KEY, "DETECTED")
    env.transport.send.mockImplementationOnce(async (tok: string, push: LivePush) => {
      env.sent.push({ token: tok, push, at: env.now() })
      await env.enroll(1, 2, 2)
      return { kind: "ok" }
    })
    await run(env, 3_000)
    expect(env.sent.map((s) => s.token).slice(0, 2)).toEqual([token(1), token(2)])
    expect(ranks(env.sent).slice(0, 2)).toEqual([0, 0])
    expect(env.sent[1].push.timestamp).toBeGreaterThan(env.sent[0].push.timestamp)
  })

  it("keeps a withdrawal that arrives before an older enrollment", async () => {
    const env = setup()
    expect(await env.withdraw(1, 5)).toBe("withdrawn")
    expect(await env.enroll(1, 1, 4)).toBe("stale")
    env.statuses.set(KEY, "DETECTED")
    await run(env, 3_000)
    expect(env.sent).toEqual([])
    // A newer opt-in from the same activity is honoured.
    expect(await env.enroll(1, 1, 6)).toBe("enrolled")
    await run(env, 3_000)
    expect(ranks(env.sent)).toEqual([0, 1])
  })

  it("drops a token APNs says is gone, until the device sends a new one", async () => {
    const env = setup()
    await env.enroll(1, 1)
    env.statuses.set(KEY, "DETECTED")
    env.results.push({ kind: "gone", reason: "Unregistered" })
    await run(env, 5_000)
    expect(env.sent).toHaveLength(1)
    expect(slot(env)).toMatchObject({ state: "REVOKED", sentRank: -1 })
    expect(slot(env).sealed).toBeUndefined()
    expect(await env.enroll(1, 2, 2)).toBe("enrolled")
    await run(env, 3_000)
    expect(env.sent.map((s) => s.token)).toEqual([token(1), token(2), token(2)])
    expect(ranks(env.sent)).toEqual([0, 0, 1])
  })

  it("retries with backoff and fresh, increasing timestamps", async () => {
    const env = setup()
    await env.enroll(1, 1)
    env.statuses.set(KEY, "DETECTED")
    env.results.push({ kind: "retry", reason: "ServiceUnavailable" })
    env.results.push({ kind: "retry", reason: "TooManyRequests", retryAfterMs: 5_000 })
    await run(env, 12_000)
    expect(ranks(env.sent)).toEqual([0, 0, 0, 1])
    // 1 s backoff, then the 5 s APNs asked for.
    expect(env.sent[1].at - env.sent[0].at).toBeGreaterThanOrEqual(1_000)
    expect(env.sent[2].at - env.sent[1].at).toBeGreaterThanOrEqual(5_000)
    const stamps = env.sent.map((s) => s.push.timestamp)
    for (let i = 1; i < stamps.length; i++)
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1])
  })

  it("gives up on a device after a bounded number of attempts", async () => {
    const env = setup()
    await env.enroll(1, 1)
    env.statuses.set(KEY, "DETECTED")
    env.transport.send.mockImplementation(async (tok: string, push: LivePush) => {
      env.sent.push({ token: tok, push, at: env.now() })
      throw new Error("socket hang up")
    })
    await run(env, 10 * 60_000)
    expect(env.sent).toHaveLength(MAX_ATTEMPTS)
    expect(slot(env)).toMatchObject({ state: "FAILED" })
    expect(slot(env).sealed).toBeUndefined()
  })

  it("changes nothing while the checkout cannot be read, and ends when it is gone", async () => {
    const env = setup()
    await env.enroll(1, 1)
    env.statuses.set(KEY, "DETECTED")
    ;(env.deps.checkout.status as jest.Mock).mockRejectedValueOnce(
      new Error("mongo down"),
    )
    await env.tick()
    expect(env.sent).toEqual([])
    expect(env.reports.map((r) => r.event)).toContain("live_status_unreadable")
    env.advance(3_000)
    await env.tick()
    expect(ranks(env.sent)).toEqual([0])

    env.statuses.delete(KEY)
    await run(env, 3_000)
    expect(env.docs.get(KEY)!.done).toBe(true)
    expect(env.docs.get(KEY)!.slots[0].sealed).toBeUndefined()
  })

  it("ends at the follow window, wipes tokens and refuses to restart", async () => {
    const env = setup()
    await env.enroll(1, 1)
    env.advance(60 * 60_000)
    await env.tick()
    const doc = env.docs.get(KEY)!
    expect(doc.done).toBe(true)
    expect(doc.slots[0].sealed).toBeUndefined()
    expect(doc.expiresAt).toBeLessThanOrEqual(env.now() + 24 * 60 * 60_000)
    await expect(env.enroll(1, 1, 2)).rejects.toThrow("ended")
    expect(await env.withdraw(1, 3)).toBe("withdrawn")
  })

  it("sends a push once when two workers run at the same time", async () => {
    const env = setup()
    await env.enroll(1, 1)
    env.statuses.set(KEY, "DETECTED")
    await Promise.all([env.tick(), env.tick(), env.tick()])
    expect(env.sent).toHaveLength(1)
  })

  it("contains one receipt's failure and reports no secrets", async () => {
    const env = setup()
    await env.enroll(1, 1)
    await env.consent({
      receiptId: OTHER_RECEIPT,
      saleKey: saleKey(OTHER_RECEIPT),
      pushToken: token(9),
    })
    env.statuses.set(KEY, "DETECTED")
    env.statuses.set(sha(OTHER_RECEIPT), "DETECTED")
    const load = env.deps.store.load
    env.deps.store.load = async (k) => {
      if (k === sha(OTHER_RECEIPT)) throw new Error("boom")
      return load(k)
    }
    const totals = await env.tick()
    expect(totals).toMatchObject({ receipts: 2, pushed: 1, errors: 1 })
    expect(env.sent.map((s) => s.token)).toEqual([token(1)])

    env.results.push({ kind: "refused", reason: "PayloadTooLarge" })
    env.advance(2_000)
    await env.tick()
    const logged = JSON.stringify(env.reports)
    for (const secret of [token(1), token(9), RECEIPT, OTHER_RECEIPT, saleKey(), KEY])
      expect(logged).not.toContain(secret)
    expect(env.reports.map((r) => r.event)).toEqual(
      expect.arrayContaining(["live_follow_error", "live_push_not_accepted"]),
    )
  })

  it("only ever reads the checkout's status", () => {
    const env = setup()
    expect(Object.keys(env.deps.checkout)).toEqual(["status"])
  })
})
