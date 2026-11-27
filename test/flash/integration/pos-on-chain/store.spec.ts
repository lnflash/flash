/**
 * The POS on-chain checkout keeps a payment destination correct through Mongo
 * behaviours the unit spec only fakes: the lease claim and its expiry, the
 * staged candidate, publish-once, and the partial unique index on
 * {address, network}. These run against the real collection.
 */
import crypto from "crypto"

import { ReusedAddressError, Row } from "@app/pos-on-chain/checkout"
import { PosOnChainCheckoutRecord, posOnChainStore } from "@services/pos-on-chain/store"

const keys: string[] = []
const newRow = async (): Promise<Row> => {
  const row: Row = {
    _id: crypto.randomBytes(32).toString("hex"),
    recipientWalletId: crypto.randomUUID(),
    sats: 1000,
    network: "SIGNET",
  }
  keys.push(row._id)
  await posOnChainStore.reserve(row)
  return row
}
const newAddress = () => "tb1q" + crypto.randomBytes(16).toString("hex")
const stored = (key: string) => PosOnChainCheckoutRecord.findById(key).lean()

describe("POS on-chain checkout store", () => {
  // Inside the describe, so it runs before the setup file closes the connection.
  afterAll(async () => {
    await PosOnChainCheckoutRecord.deleteMany({ _id: { $in: keys } })
  })

  it("reserves a sale once", async () => {
    const row = await newRow()
    await posOnChainStore.reserve({ ...row, sats: 5 })
    expect((await posOnChainStore.read(row._id))?.sats).toBe(1000)
  })

  it("grants exactly one of two concurrent claims", async () => {
    const row = await newRow()
    const claims = await Promise.all([
      posOnChainStore.claim(row._id, "lease-a"),
      posOnChainStore.claim(row._id, "lease-b"),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it("grants a claim once the previous lease has expired", async () => {
    const row = await newRow()
    expect(await posOnChainStore.claim(row._id, "lease-a")).toBe(true)
    expect(await posOnChainStore.claim(row._id, "lease-b")).toBe(false)
    await PosOnChainCheckoutRecord.updateOne(
      { _id: row._id },
      { $set: { until: new Date(Date.now() - 1000) } },
    )
    expect(await posOnChainStore.claim(row._id, "lease-b")).toBe(true)
    expect((await stored(row._id))?.lease).toBe("lease-b")
  })

  it("stages one candidate under the lease, and discards it", async () => {
    const row = await newRow()
    const first = newAddress()
    await posOnChainStore.claim(row._id, "lease-a")
    expect(await posOnChainStore.stage(row._id, "lease-x", first)).toBe(false)
    expect(await posOnChainStore.stage(row._id, "lease-a", first)).toBe(true)
    expect(await posOnChainStore.stage(row._id, "lease-a", newAddress())).toBe(false)
    expect((await posOnChainStore.read(row._id))?.candidate).toBe(first)
    // Survives the lease, so the next attempt reuses it.
    await posOnChainStore.release(row._id, "lease-a")
    expect((await posOnChainStore.read(row._id))?.candidate).toBe(first)
    await posOnChainStore.claim(row._id, "lease-b")
    await posOnChainStore.discard(row._id, "lease-b")
    expect((await posOnChainStore.read(row._id))?.candidate).toBeUndefined()
  })

  it("publishes once, under the current lease only, and clears the candidate", async () => {
    const row = await newRow()
    const address = newAddress()
    await posOnChainStore.claim(row._id, "lease-a")
    await posOnChainStore.stage(row._id, "lease-a", address)
    expect(await posOnChainStore.publish(row._id, "stale", address)).toBe(false)
    expect(await posOnChainStore.publish(row._id, "lease-a", address)).toBe(true)
    expect(await posOnChainStore.publish(row._id, "lease-a", newAddress())).toBe(false)
    const doc = await stored(row._id)
    expect(doc?.address).toBe(address)
    expect(doc?.candidate).toBeUndefined()
    expect(doc?.lease).toBeUndefined()
    expect(await posOnChainStore.claim(row._id, "lease-b")).toBe(false)
  })

  it("refuses an address another sale already holds", async () => {
    const [held, next] = [await newRow(), await newRow()]
    const address = newAddress()
    await posOnChainStore.claim(held._id, "lease-a")
    await posOnChainStore.publish(held._id, "lease-a", address)
    await posOnChainStore.claim(next._id, "lease-b")
    await expect(posOnChainStore.publish(next._id, "lease-b", address)).rejects.toThrow(
      ReusedAddressError,
    )
    expect((await stored(next._id))?.address).toBeUndefined()
  })

  it("leaves the holder's lease alone when another lease releases", async () => {
    const row = await newRow()
    await posOnChainStore.claim(row._id, "lease-a")
    await posOnChainStore.release(row._id, "lease-b")
    const doc = await stored(row._id)
    expect(doc?.lease).toBe("lease-a")
    expect(doc?.until).toBeInstanceOf(Date)
  })
})
