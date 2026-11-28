import { createHash } from "crypto"

import {
  CollisionError,
  Credit,
  Dependencies,
  parseHubEvent,
  parseMicroUsdt,
  PostedReadback,
  ProviderRejectedError,
  Row,
  Store,
  usdtCheckoutService,
} from "@app/pos-usdt-checkout/checkout"

const MERCHANT = "merchant-wallet"
const ip = "192.0.2.15"
const sale = (requestId: string, amountMinor = 1235) => ({
  recipientWalletId: MERCHANT,
  requestId,
  amountMinor,
})
const A = "a".repeat(64)
const B = "b".repeat(64)
const sha = (v: string) => createHash("sha256").update(v).digest("hex")
const keyOf = (requestId: string) =>
  sha(sha(`flash-pos-usdt-v1/${MERCHANT}/${requestId}`))
const txid = (n: number) => "0x" + n.toString(16).padStart(64, "0")

// The Mongo store's conditional updates and unique indexes, in memory. The
// clock drives touch's 15-second recheck window on the durable checkedAt.
function memoryStore(clock = { now: 0 }) {
  const rows = new Map<string, Row & { lease?: string }>()
  const credits = new Map<string, Credit>()
  const open = (r: Row) => !r.address && !r.failed
  const store: Store = {
    async read(k) {
      const r = rows.get(k)
      return r ? { ...r } : null
    },
    async findByReceiveInfo(id) {
      const r = [...rows.values()].find((x) => x.address && x.receiveInfoId === id)
      return r ? { ...r } : null
    },
    async reserve(row) {
      if (!rows.has(row._id)) rows.set(row._id, { ...row })
    },
    async claim(k, lease) {
      const r = rows.get(k)
      if (!r || !open(r) || r.lease) return false
      r.lease = lease
      return true
    },
    async begin(k, lease, attempt) {
      const r = rows.get(k)
      if (!r || r.lease !== lease || !open(r) || r.attempt || r.candidate) return false
      r.attempt = attempt
      return true
    },
    async abandon(k, lease, attempt) {
      const r = rows.get(k)
      if (r && r.lease === lease && r.attempt === attempt) delete r.attempt
    },
    async stage(k, lease, attempt, allocation) {
      const r = rows.get(k)
      if (!r || r.lease !== lease || r.attempt !== attempt || !open(r)) return false
      r.candidate = allocation
      delete r.attempt
      return true
    },
    async fail(k, reason) {
      const r = rows.get(k)
      if (r && open(r)) r.failed = reason
    },
    async publish(k, lease, a) {
      const r = rows.get(k)
      if (!r || r.lease !== lease || !open(r)) return false
      if (
        [...rows.values()].some(
          (o) =>
            o !== r &&
            o.address &&
            (o.address === a.address || o.receiveInfoId === a.receiveInfoId),
        )
      )
        throw new CollisionError()
      Object.assign(r, a)
      delete r.candidate
      delete r.attempt
      delete r.lease
      return true
    },
    async release(k, lease) {
      const r = rows.get(k)
      if (r && r.lease === lease) delete r.lease
    },
    async credits(k) {
      return [...credits.values()]
        .filter((c) => c.checkoutKey === k)
        .map((c) => ({ ...c }))
    },
    async addCredit(c) {
      const existing = credits.get(c._id)
      if (existing) return { ...existing }
      credits.set(c._id, { ...c })
      return { ...c }
    },
    async post(id, e) {
      const c = credits.get(id)
      if (
        c &&
        c.state === "DETECTED" &&
        c.checkoutKey === e.checkoutKey &&
        c.amountMicro === e.amountMicro &&
        c.txid === e.txid &&
        c.walletId === e.walletId
      )
        c.state = "POSTED"
    },
    async touch(id) {
      const c = credits.get(id)
      if (!c || c.state !== "DETECTED") return false
      if (c.checkedAt && c.checkedAt.getTime() >= clock.now - 15_000) return false
      // Each claim takes a moment, as successive Mongo writes do.
      c.checkedAt = new Date(clock.now++)
      return true
    },
  }
  return { store, rows, credits }
}

function setup() {
  // Starts past the recheck window, so a never-checked credit is due at once.
  const clock = { now: 1_000_000 }
  const { store, rows, credits } = memoryStore(clock)
  // IBEX's ledger as read back by transaction id.
  const ledger = new Map<string, PostedReadback>()
  let n = 0
  const deps: Dependencies = {
    store,
    enabled: (id) => id === MERCHANT,
    limitNew: jest.fn(async () => undefined),
    newReceiveInfo: jest.fn(async () => {
      n++
      return {
        id: `ri-${n}`,
        data: { address: "0x" + String(n).padStart(40, "A") },
        network: "ethereum",
        currency: "USDT",
      }
    }),
    reservedAddresses: jest.fn(async () => []),
    readPosted: jest.fn(async (id: string) => ledger.get(id) ?? null),
    report: jest.fn(),
  }
  return { deps, rows, credits, ledger, clock, service: usdtCheckoutService(deps) }
}

type Env = ReturnType<typeof setup>

const event = (o: {
  tx: string
  receiveInfoId: string
  amount: unknown
  hash?: string
  accountId?: string
  status?: string
}) => ({
  event: "Transactions",
  transaction: {
    id: o.tx,
    transactionTypeId: 9,
    accountId: o.accountId ?? MERCHANT,
    amount: o.amount,
    currencyId: 29,
    status: o.status ?? "completed",
  },
  receiveInfo: { id: o.receiveInfoId, network: "Ethereum", txid: o.hash ?? txid(1) },
})

// IBEX posts a credit and Hub reports it.
async function credit(
  env: Env,
  o: { tx: string; receiveInfoId: string; amount: number | string; hash?: string },
  status = "completed",
) {
  env.ledger.set(o.tx, {
    accountId: MERCHANT,
    amount: o.amount,
    transactionTypeId: 9,
    status,
    currencyId: 29,
    txid: (o.hash ?? txid(1)).toUpperCase().replace("0X", "0x"),
  })
  return env.service.ingest(event({ ...o, status }))
}

const receiveInfoOf = (env: Env, requestId: string) =>
  env.rows.get(keyOf(requestId))!.receiveInfoId!

// IBEX has the credit in its ledger and Hub reports it; only the recording
// step runs, as before the webhook's answer, with no read-back.
async function recordOnly(
  env: Env,
  o: { tx: string; receiveInfoId: string; amount: number | string; hash?: string },
  status = "completed",
) {
  env.ledger.set(o.tx, {
    accountId: MERCHANT,
    amount: o.amount,
    transactionTypeId: 9,
    status,
    currencyId: 29,
    txid: o.hash ?? txid(1),
  })
  return env.service.record(event({ ...o, status }))
}

describe("creating a sale", () => {
  it("returns the same destination after a lost response, allocating once", async () => {
    const env = setup()
    const first = await env.service.create(sale(A), ip)
    expect(first).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      recipientWalletId: MERCHANT,
      address: "0x" + "a".repeat(39) + "1",
      network: "ETHEREUM",
      status: "AWAITING_PAYMENT",
      amountMinor: 1235,
    })
    expect(await env.service.create(sale(A), ip)).toEqual(first)
    expect(await env.service.status(first.id)).toEqual(first)
    expect(env.deps.newReceiveInfo).toHaveBeenCalledTimes(1)
    expect(env.deps.limitNew).toHaveBeenCalledTimes(1)
    // Only the digest of the receipt capability is stored, and the provider
    // name never carries it.
    expect(env.rows.has(first.id)).toBe(false)
    const [, name] = (env.deps.newReceiveInfo as jest.Mock).mock.calls[0]
    expect(name).not.toContain(first.id)
    await expect(env.service.create(sale(A, 1236), ip)).rejects.toThrow(
      /different payment/,
    )
  })

  it("refuses bad input, oversized sales and ineligible wallets without allocating", async () => {
    const env = setup()
    for (const input of [
      sale("short"),
      sale(A, 0),
      sale(A, 12.5),
      sale(A, 1_000_001),
      { ...sale(A), recipientWalletId: "someone-else" },
    ])
      await expect(env.service.create(input, ip)).rejects.toThrow()
    expect(env.deps.newReceiveInfo).not.toHaveBeenCalled()
    expect(env.deps.limitNew).not.toHaveBeenCalled()
    expect(await env.service.supports("someone-else")).toBe(false)
    expect(await env.service.supports(MERCHANT)).toBe(true)
  })

  it("allocates once across concurrent creates of one sale", async () => {
    const env = setup()
    const results = await Promise.allSettled([
      env.service.create(sale(A), ip),
      env.service.create(sale(A), ip),
    ])
    expect(results.some((r) => r.status === "fulfilled")).toBe(true)
    expect(env.deps.newReceiveInfo).toHaveBeenCalledTimes(1)
    const again = await env.service.create(sale(A), ip)
    const addresses = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value.address] : [],
    )
    expect(new Set(addresses)).toEqual(new Set([again.address]))
  })

  it("gives two sales of the same price their own receive info and address", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const b = await env.service.create(sale(B), ip)
    expect(a.id).not.toBe(b.id)
    expect(a.address).not.toBe(b.address)
    expect(receiveInfoOf(env, A)).not.toBe(receiveInfoOf(env, B))
  })

  it("never asks again after a provider call with an unknown outcome", async () => {
    const env = setup()
    ;(env.deps.newReceiveInfo as jest.Mock).mockRejectedValueOnce(new Error("timeout"))
    await expect(env.service.create(sale(A), ip)).rejects.toThrow(
      /could not be confirmed/,
    )
    await expect(env.service.create(sale(A), ip)).rejects.toThrow(/cannot receive/)
    expect(env.deps.newReceiveInfo).toHaveBeenCalledTimes(1)
    expect(env.deps.report).toHaveBeenCalledWith(
      "ambiguous_allocation",
      expect.anything(),
    )
  })

  it("treats an attempt left behind by a crash as unknown", async () => {
    const env = setup()
    await env.service.create(sale(A), ip).catch(() => undefined)
    // Simulate a process that died mid-call: the marker stays, nothing staged.
    const { rows } = env
    rows.set(keyOf(B), {
      _id: keyOf(B),
      recipientWalletId: MERCHANT,
      amountMinor: 1235,
      network: "ETHEREUM",
      attempt: "lost",
    })
    const before = (env.deps.newReceiveInfo as jest.Mock).mock.calls.length
    await expect(env.service.create(sale(B), ip)).rejects.toThrow(
      /could not be confirmed/,
    )
    expect((env.deps.newReceiveInfo as jest.Mock).mock.calls.length).toBe(before)
    expect(rows.get(keyOf(B))!.failed).toBe("AMBIGUOUS")
  })

  it("retries after a definite provider refusal", async () => {
    const env = setup()
    ;(env.deps.newReceiveInfo as jest.Mock).mockRejectedValueOnce(
      new ProviderRejectedError("400"),
    )
    await expect(env.service.create(sale(A), ip)).rejects.toThrow(/could not issue/)
    const ok = await env.service.create(sale(A), ip)
    expect(ok.status).toBe("AWAITING_PAYMENT")
    expect(env.deps.newReceiveInfo).toHaveBeenCalledTimes(2)
    expect(env.deps.limitNew).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      "the same address",
      (n: number) => ({ id: `ri-x${n}`, data: { address: "0x" + "a".repeat(39) + "1" } }),
    ],
    [
      "the same receive info",
      () => ({ id: "ri-1", data: { address: "0x" + "c".repeat(40) } }),
    ],
  ])("fails closed when the provider reuses %s", async (_label, second) => {
    const env = setup()
    await env.service.create(sale(A), ip)
    ;(env.deps.newReceiveInfo as jest.Mock).mockResolvedValueOnce(second(2))
    await expect(env.service.create(sale(B), ip)).rejects.toThrow(CollisionError)
    await expect(env.service.create(sale(B), ip)).rejects.toThrow(/cannot receive/)
    expect(env.deps.newReceiveInfo).toHaveBeenCalledTimes(2)
  })

  it("never hands a sale the account's Bridge deposit address", async () => {
    const env = setup()
    ;(env.deps.reservedAddresses as jest.Mock).mockResolvedValue([
      "0x" + "A".repeat(39) + "1",
    ])
    await expect(env.service.create(sale(A), ip)).rejects.toThrow(CollisionError)
    expect(env.rows.get(keyOf(A))!.address).toBeUndefined()
  })

  it.each([
    [
      "a Tron receive info",
      { id: "ri-t", data: { address: "0x" + "d".repeat(40) }, network: "tron" },
    ],
    ["a non-EVM address", { id: "ri-t", data: { address: "TXYZ" }, network: "ethereum" }],
    [
      "another wallet's",
      { id: "ri-t", data: { address: "0x" + "d".repeat(40) }, wallet_id: "other" },
    ],
    [
      "a non-USDT currency",
      { id: "ri-t", data: { address: "0x" + "d".repeat(40) }, currency: "USDC" },
    ],
    ["no id", { data: { address: "0x" + "d".repeat(40) } }],
  ])("fails closed on %s", async (_label, raw) => {
    const env = setup()
    ;(env.deps.newReceiveInfo as jest.Mock).mockResolvedValueOnce(raw)
    await expect(env.service.create(sale(A), ip)).rejects.toThrow(/unusable/)
    await expect(env.service.create(sale(A), ip)).rejects.toThrow(/cannot receive/)
    expect(env.deps.newReceiveInfo).toHaveBeenCalledTimes(1)
  })

  it("answers an unknown or malformed receipt the same way", async () => {
    const env = setup()
    await expect(env.service.status("c".repeat(64))).rejects.toThrow("Unknown checkout.")
    await expect(env.service.status("not-a-capability")).rejects.toThrow(
      "Unknown checkout.",
    )
  })
})

describe("payments", () => {
  it("credits only the sale whose receive info was paid, for two sales at the same price", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const b = await env.service.create(sale(B), ip)
    expect(
      await credit(env, {
        tx: "t-1",
        receiveInfoId: receiveInfoOf(env, B),
        amount: 12.35,
      }),
    ).toBe("posted")
    expect((await env.service.status(a.id)).status).toBe("AWAITING_PAYMENT")
    expect((await env.service.status(b.id)).status).toBe("PAID")
  })

  it("counts a repeated notification once", async () => {
    const env = setup()
    const a = await env.service.create(sale(A, 2000), ip)
    const ri = receiveInfoOf(env, A)
    expect(await credit(env, { tx: "t-1", receiveInfoId: ri, amount: 10 })).toBe("posted")
    for (let i = 0; i < 3; i++)
      expect(
        await env.service.ingest(event({ tx: "t-1", receiveInfoId: ri, amount: 10 })),
      ).toBe("already_posted")
    expect(env.credits.size).toBe(1)
    // Half the price, however often it is reported.
    expect((await env.service.status(a.id)).status).toBe("DETECTED")
  })

  it("adds partial payments exactly, to the micro-unit", async () => {
    const env = setup()
    const a = await env.service.create(sale(A, 1235), ip)
    const ri = receiveInfoOf(env, A)
    await credit(env, { tx: "t-1", receiveInfoId: ri, amount: 12.34, hash: txid(1) })
    await credit(env, { tx: "t-2", receiveInfoId: ri, amount: "0.009999", hash: txid(2) })
    expect((await env.service.status(a.id)).status).toBe("DETECTED")
    await credit(env, { tx: "t-3", receiveInfoId: ri, amount: "0.000001", hash: txid(3) })
    expect((await env.service.status(a.id)).status).toBe("PAID")
  })

  it("handles a pending event, a later completion and a stale redelivery in any order", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    expect(
      await credit(env, { tx: "t-1", receiveInfoId: ri, amount: 12.35 }, "pending"),
    ).toBe("unverified")
    expect((await env.service.status(a.id)).status).toBe("DETECTED")
    expect(await credit(env, { tx: "t-1", receiveInfoId: ri, amount: 12.35 })).toBe(
      "posted",
    )
    expect((await env.service.status(a.id)).status).toBe("PAID")
    // The pending delivery again, late: never moves a credit back.
    expect(
      await env.service.ingest(
        event({ tx: "t-1", receiveInfoId: ri, amount: 12.35, status: "pending" }),
      ),
    ).toBe("already_posted")
    expect((await env.service.status(a.id)).status).toBe("PAID")
  })

  it("confirms a credit by status poll when the completion event is lost", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    await credit(env, { tx: "t-1", receiveInfoId: ri, amount: 12.35 }, "pending")
    env.ledger.set("t-1", { ...env.ledger.get("t-1"), status: "completed" })
    expect((await env.service.status(a.id)).status).toBe("PAID")
  })

  it("reaches paid with both registers locked and a missing completion webhook", async () => {
    const env = setup()
    const saleA = await env.service.create(sale(A), ip)
    const saleB = await env.service.create(sale(B), ip)
    await credit(
      env,
      { tx: "t-locked", receiveInfoId: receiveInfoOf(env, A), amount: 12.35 },
      "pending",
    )
    env.ledger.set("t-locked", { ...env.ledger.get("t-locked"), status: "completed" })
    expect(await env.service.followedStatus(sha(saleA.id))).toBe("PAID")
    expect(await env.service.followedStatus(sha(saleB.id))).toBe("AWAITING_PAYMENT")
  })

  it("stays DETECTED while IBEX cannot be read back", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    ;(env.deps.readPosted as jest.Mock).mockRejectedValue(new Error("offline"))
    expect(
      await env.service.ingest(event({ tx: "t-1", receiveInfoId: ri, amount: 12.35 })),
    ).toBe("unverified")
    expect((await env.service.status(a.id)).status).toBe("DETECTED")
  })

  it.each([
    ["a different amount", { amount: 12.34 }],
    ["another account", { accountId: "other-wallet" }],
    ["another tx hash", { txid: txid(9) }],
    ["another transaction type", { transactionTypeId: 1 }],
    ["a USD currency", { currencyId: 3 }],
  ])("never pays a sale on a read-back with %s", async (_label, change) => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    env.ledger.set("t-1", {
      accountId: MERCHANT,
      amount: 12.35,
      transactionTypeId: 9,
      status: "completed",
      currencyId: 29,
      txid: txid(1),
      ...change,
    })
    expect(
      await env.service.ingest(event({ tx: "t-1", receiveInfoId: ri, amount: 12.35 })),
    ).toBe("unverified")
    expect((await env.service.status(a.id)).status).toBe("DETECTED")
    expect(env.deps.report).toHaveBeenCalledWith("readback_mismatch", expect.anything())
  })

  it("keeps the first report of a transaction when a redelivery disagrees", async () => {
    const env = setup()
    const a = await env.service.create(sale(A, 2000), ip)
    const ri = receiveInfoOf(env, A)
    await credit(env, { tx: "t-1", receiveInfoId: ri, amount: 10 })
    expect(
      await env.service.ingest(event({ tx: "t-1", receiveInfoId: ri, amount: 20 })),
    ).toBe("conflict")
    expect((await env.service.status(a.id)).status).toBe("DETECTED")
  })

  it("refuses a credit on another wallet against a sale's receive info", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    expect(
      await env.service.ingest(
        event({ tx: "t-1", receiveInfoId: ri, amount: 12.35, accountId: "other" }),
      ),
    ).toBe("mismatch")
    expect(env.credits.size).toBe(0)
    expect((await env.service.status(a.id)).status).toBe("AWAITING_PAYMENT")
  })

  it("never ties a payment to a sale by its address or amount", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const body = event({ tx: "t-1", receiveInfoId: "unused", amount: 12.35 }) as Record<
      string,
      unknown
    >
    // A receive with the sale's address and price but no receive info id.
    delete body.receiveInfo
    body.crypto = {
      network: "Ethereum",
      networkTransactionId: txid(1),
      address: a.address,
    }
    expect(await env.service.ingest(body)).toBe("ignored")
    // The Bridge deposit's receive info, or any other, is not a sale.
    expect(
      await env.service.ingest(
        event({ tx: "t-2", receiveInfoId: "ri-bridge", amount: 12.35 }),
      ),
    ).toBe("not_pos")
    expect((await env.service.status(a.id)).status).toBe("AWAITING_PAYMENT")
    expect(env.deps.readPosted).not.toHaveBeenCalled()
  })

  it("refuses and reports provider fields it does not support", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    const base = () => event({ tx: "t-1", receiveInfoId: ri, amount: 12.35 })
    const variants: Array<(b: ReturnType<typeof base>) => unknown> = [
      (b) => ({ ...b, receiveInfo: { ...b.receiveInfo, network: "tron" } }),
      (b) => ({ ...b, receiveInfo: { ...b.receiveInfo, txid: "not-a-hash" } }),
      (b) => ({ ...b, receiveInfo: { id: ri, network: "ethereum" } }),
      (b) => ({ ...b, receiveInfo: "ri-1" }),
      (b) => ({ ...b, transaction: { ...b.transaction, amount: "1e3" } }),
      (b) => ({ ...b, transaction: { ...b.transaction, amount: 12.3456789 } }),
      (b) => ({ ...b, transaction: { ...b.transaction, amount: { value: 12.35 } } }),
      (b) => ({ ...b, transaction: { ...b.transaction, amount: -1 } }),
      (b) => ({ ...b, transaction: { ...b.transaction, currencyId: 3 } }),
      (b) => ({ ...b, transaction: { ...b.transaction, accountId: 42 } }),
      (b) => ({ ...b, crypto: { network: "Ethereum", networkTransactionId: txid(7) } }),
      (b) => ({
        ...b,
        transaction: { ...b.transaction, receiveInfo: { id: "ri-other" } },
      }),
    ]
    for (const variant of variants)
      expect(await env.service.ingest(variant(base()))).toBe("rejected")
    expect(env.credits.size).toBe(0)
    expect(env.deps.report).toHaveBeenCalledWith(
      "unsupported_event",
      expect.objectContaining({ transactionId: "t-1" }),
    )
    expect((await env.service.status(a.id)).status).toBe("AWAITING_PAYMENT")
  })
})

describe("recording a webhook before its answer", () => {
  it("stores the credit durably without reading IBEX, and reads it back after", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    const recorded = await recordOnly(env, {
      tx: "t-1",
      receiveInfoId: ri,
      amount: 12.35,
    })
    expect(recorded.result).toBe("detected")
    expect(env.deps.readPosted).not.toHaveBeenCalled()
    expect(env.credits.get("t-1")).toMatchObject({
      state: "DETECTED",
      amountMicro: "12350000",
    })
    expect(await recorded.readBack!()).toBe("posted")
    expect((await env.service.status(a.id)).status).toBe("PAID")
  })

  it("leaves a credit whose read-back never ran to the next status poll", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    await recordOnly(env, {
      tx: "t-1",
      receiveInfoId: receiveInfoOf(env, A),
      amount: 12.35,
    })
    expect((await env.service.status(a.id)).status).toBe("PAID")
    expect(env.deps.readPosted).toHaveBeenCalledTimes(1)
  })

  it.each([["findByReceiveInfo" as const], ["addCredit" as const]])(
    "throws when %s fails, so the delivery is retried, and records once on the retry",
    async (method) => {
      const env = setup()
      const a = await env.service.create(sale(A), ip)
      const ri = receiveInfoOf(env, A)
      const real = env.deps.store[method]
      env.deps.store[method] = jest
        .fn()
        .mockRejectedValueOnce(new Error("mongo down"))
        .mockImplementation(real as never) as never
      await expect(
        recordOnly(env, { tx: "t-1", receiveInfoId: ri, amount: 12.35 }),
      ).rejects.toThrow("mongo down")
      expect(env.credits.size).toBe(0)
      expect(env.deps.readPosted).not.toHaveBeenCalled()

      // IBEX's redelivery, then a duplicate of it: one credit, amount intact.
      expect(
        (await recordOnly(env, { tx: "t-1", receiveInfoId: ri, amount: 12.35 })).result,
      ).toBe("detected")
      const again = await recordOnly(env, { tx: "t-1", receiveInfoId: ri, amount: 12.35 })
      expect(again.result).toBe("detected")
      expect(env.credits.size).toBe(1)
      await again.readBack!()
      expect(
        (await recordOnly(env, { tx: "t-1", receiveInfoId: ri, amount: 12.35 })).result,
      ).toBe("already_posted")
      expect((await env.service.status(a.id)).status).toBe("PAID")
    },
  )

  it("answers events it need not store with nothing to read back", async () => {
    const env = setup()
    await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    for (const [body, result] of [
      [{ event: "Applicants" }, "ignored"],
      [event({ tx: "t-2", receiveInfoId: "ri-bridge", amount: 12.35 }), "not_pos"],
      [
        event({ tx: "t-3", receiveInfoId: ri, amount: 12.35, accountId: "other" }),
        "mismatch",
      ],
      [
        { ...event({ tx: "t-4", receiveInfoId: ri, amount: 12.35 }), crypto: "x" },
        "rejected",
      ],
    ] as const) {
      const recorded = await env.service.record(body)
      expect(recorded).toEqual({ result })
    }
    expect(env.credits.size).toBe(0)
    expect(env.deps.readPosted).not.toHaveBeenCalled()
  })
})

describe("status read-back of many pending credits", () => {
  it("reaches a later credit instead of re-trying the same first three", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    // Three small credits IBEX still holds as pending, then the full payment
    // whose read-back after the webhook never happened.
    for (const n of [1, 2, 3])
      await recordOnly(
        env,
        { tx: `t-${n}`, receiveInfoId: ri, amount: "0.01", hash: txid(n) },
        "pending",
      )
    await recordOnly(env, { tx: "t-4", receiveInfoId: ri, amount: 12.35, hash: txid(4) })
    const read = env.deps.readPosted as jest.Mock

    expect((await env.service.status(a.id)).status).toBe("DETECTED")
    expect(read.mock.calls.map(([id]) => id)).toEqual(["t-1", "t-2", "t-3"])

    // The next poll, inside the recheck window of the first three.
    env.clock.now += 2_000
    expect((await env.service.status(a.id)).status).toBe("PAID")
    expect(read.mock.calls.map(([id]) => id)).toEqual(["t-1", "t-2", "t-3", "t-4"])
  })

  it("takes the least recently checked credits first, so every one gets its turn", async () => {
    const env = setup()
    const a = await env.service.create(sale(A, 1000), ip)
    const ri = receiveInfoOf(env, A)
    for (const n of [1, 2, 3, 4, 5])
      await recordOnly(
        env,
        { tx: `t-${n}`, receiveInfoId: ri, amount: "0.01", hash: txid(n) },
        "pending",
      )
    const read = env.deps.readPosted as jest.Mock
    const poll = async () => {
      read.mockClear()
      await env.service.followedStatus(sha(a.id))
      env.clock.now += 16_000
      return read.mock.calls.map(([id]) => id)
    }
    expect(await poll()).toEqual(["t-1", "t-2", "t-3"])
    expect(await poll()).toEqual(["t-4", "t-5", "t-1"])
    expect(await poll()).toEqual(["t-2", "t-3", "t-4"])
  })

  it("reads nothing back while every pending credit was checked inside the window", async () => {
    const env = setup()
    const a = await env.service.create(sale(A), ip)
    const ri = receiveInfoOf(env, A)
    for (const n of [1, 2])
      await recordOnly(
        env,
        { tx: `t-${n}`, receiveInfoId: ri, amount: "0.01", hash: txid(n) },
        "pending",
      )
    await env.service.status(a.id)
    const read = env.deps.readPosted as jest.Mock
    read.mockClear()
    env.clock.now += 5_000
    expect((await env.service.status(a.id)).status).toBe("DETECTED")
    expect(read).not.toHaveBeenCalled()
  })
})

describe("parsing", () => {
  it.each([
    [12.35, 12_350_000n],
    ["0.000001", 1n],
    [10, 10_000_000n],
    ["7.1", 7_100_000n],
  ])("reads %p USDT exactly", (value, micro) => {
    expect(parseMicroUsdt(value)).toBe(micro)
  })

  it.each([["1e-7"], [1e-7], ["12.3456789"], [NaN], [-1], [" "], [null]])(
    "refuses %p",
    (value) => {
      expect(parseMicroUsdt(value)).toBeUndefined()
    },
  )

  it("ignores events that are not crypto receives", () => {
    expect(parseHubEvent({ event: "Applicants" }).kind).toBe("ignore")
    expect(
      parseHubEvent({
        event: "Transactions",
        transaction: { id: "t", transactionTypeId: 1 },
      }).kind,
    ).toBe("ignore")
  })
})

it("credits the merchant's USDT wallet when the register uses the same merchant's USD wallet", async () => {
  const env = setup()
  env.deps.enabled = (id) => (id === MERCHANT ? "owned-usdt-wallet" : false)
  const receipt = await env.service.create(sale(A, 100), ip)
  expect(receipt.recipientWalletId).toBe(MERCHANT)
  expect(env.deps.newReceiveInfo).toHaveBeenCalledWith(
    "owned-usdt-wallet",
    expect.any(String),
  )
  const signal = { tx: "tx-owned", receiveInfoId: receiveInfoOf(env, A), amount: "1.00" }
  expect(await env.service.ingest(event(signal))).toBe("mismatch")
  env.ledger.set(signal.tx, {
    accountId: "owned-usdt-wallet",
    amount: "1.00",
    transactionTypeId: 9,
    status: "completed",
    currencyId: 29,
    txid: txid(1),
  })
  await env.service.ingest(event({ ...signal, accountId: "owned-usdt-wallet" }))
  expect((await env.service.status(receipt.id)).status).toBe("PAID")
})
