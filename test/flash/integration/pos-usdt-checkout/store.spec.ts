/**
 * The POS USDT checkout's fences against the real collections: the attempt
 * marker, publish-once, the unique indexes on the receive info and the
 * address, one credit per IBEX transaction, and DETECTED -> POSTED only.
 */
import crypto from "crypto"

import { CollisionError, Credit, Row } from "@app/pos-usdt-checkout/checkout"
import {
  PosUsdtCheckoutCredit,
  PosUsdtCheckoutRecord,
  posUsdtStore,
} from "@services/pos-usdt-checkout/store"

const keys: string[] = []
const creditIds: string[] = []
const newRow = async (): Promise<Row> => {
  const row: Row = {
    _id: crypto.randomBytes(32).toString("hex"),
    recipientWalletId: crypto.randomUUID(),
    amountMinor: 1235,
    network: "ETHEREUM",
  }
  keys.push(row._id)
  await posUsdtStore.reserve(row)
  return row
}
const allocation = () => ({
  receiveInfoId: crypto.randomUUID(),
  address: "0x" + crypto.randomBytes(20).toString("hex"),
})
const stored = (key: string) => PosUsdtCheckoutRecord.findById(key).lean()

describe("POS USDT checkout store", () => {
  afterAll(async () => {
    await PosUsdtCheckoutRecord.deleteMany({ _id: { $in: keys } })
    await PosUsdtCheckoutCredit.deleteMany({ _id: { $in: creditIds } })
  })

  it("lets one attempt ask the provider, and keeps the marker past the lease", async () => {
    const row = await newRow()
    await posUsdtStore.claim(row._id, "lease-a")
    expect(await posUsdtStore.begin(row._id, "lease-x", "try-1")).toBe(false)
    expect(await posUsdtStore.begin(row._id, "lease-a", "try-1")).toBe(true)
    expect(await posUsdtStore.begin(row._id, "lease-a", "try-2")).toBe(false)
    await posUsdtStore.release(row._id, "lease-a")
    expect((await posUsdtStore.read(row._id))?.attempt).toBe("try-1")
  })

  it("stages under the attempt, publishes once and refuses a reused receive info or address", async () => {
    const [held, next, other] = [await newRow(), await newRow(), await newRow()]
    const a = allocation()
    await posUsdtStore.claim(held._id, "lease-a")
    await posUsdtStore.begin(held._id, "lease-a", "try-1")
    expect(await posUsdtStore.stage(held._id, "lease-a", "try-0", a)).toBe(false)
    expect(await posUsdtStore.stage(held._id, "lease-a", "try-1", a)).toBe(true)
    expect(await posUsdtStore.publish(held._id, "stale", a)).toBe(false)
    expect(await posUsdtStore.publish(held._id, "lease-a", a)).toBe(true)
    const doc = await stored(held._id)
    expect(doc?.address).toBe(a.address)
    expect(doc?.receiveInfoId).toBe(a.receiveInfoId)
    expect(doc?.attempt).toBeUndefined()
    expect(doc?.candidate).toBeUndefined()
    expect((await posUsdtStore.findByReceiveInfo(a.receiveInfoId))?._id).toBe(held._id)

    await posUsdtStore.claim(next._id, "lease-b")
    await expect(
      posUsdtStore.publish(next._id, "lease-b", { ...allocation(), address: a.address }),
    ).rejects.toThrow(CollisionError)
    await posUsdtStore.claim(other._id, "lease-c")
    await expect(
      posUsdtStore.publish(other._id, "lease-c", {
        ...allocation(),
        receiveInfoId: a.receiveInfoId,
      }),
    ).rejects.toThrow(CollisionError)
  })

  it("never claims a failed sale", async () => {
    const row = await newRow()
    await posUsdtStore.fail(row._id, "AMBIGUOUS")
    expect(await posUsdtStore.claim(row._id, "lease-a")).toBe(false)
  })

  it("stores one credit per IBEX transaction and only moves it forward", async () => {
    const row = await newRow()
    const credit: Credit = {
      _id: crypto.randomUUID(),
      checkoutKey: row._id,
      receiveInfoId: "ri",
      walletId: row.recipientWalletId,
      txid: "0x" + "1".repeat(64),
      amountMicro: "12350000",
      state: "DETECTED",
    }
    creditIds.push(credit._id)
    const [first, second] = await Promise.all([
      posUsdtStore.addCredit(credit),
      posUsdtStore.addCredit({ ...credit, amountMicro: "1" }),
    ])
    // Whichever insert won, both callers see the same stored credit.
    expect(second.amountMicro).toBe(first.amountMicro)
    const kept = (await posUsdtStore.credits(row._id))[0]
    expect(await posUsdtStore.credits(row._id)).toHaveLength(1)
    // The wrong expectation never posts it.
    await posUsdtStore.post(credit._id, { ...kept, amountMicro: "999" })
    expect((await posUsdtStore.credits(row._id))[0].state).toBe("DETECTED")
    // Never checked yet: no check time, so a status poll takes it first.
    expect(kept.checkedAt).toBeUndefined()
    const before = Date.now()
    expect(await posUsdtStore.touch(credit._id)).toBe(true)
    expect(await posUsdtStore.touch(credit._id)).toBe(false)
    // The durable check time comes back with the credit, for fair ordering.
    const checkedAt = (await posUsdtStore.credits(row._id))[0].checkedAt
    expect(checkedAt).toBeInstanceOf(Date)
    expect(checkedAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000)
    await posUsdtStore.post(credit._id, kept)
    expect((await posUsdtStore.credits(row._id))[0].state).toBe("POSTED")
    expect(await posUsdtStore.touch(credit._id)).toBe(false)
  })
})
