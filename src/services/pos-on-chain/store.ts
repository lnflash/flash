import mongoose from "mongoose"
import type { Row, Store } from "@app/pos-on-chain/checkout"

// An address is never reallocated, including after its received outputs are spent.
type Doc = Row & { lease?: string; until?: Date }
const schema = new mongoose.Schema<Doc>(
  {
    _id: String,
    recipientWalletId: { type: String, required: true },
    sats: { type: Number, required: true },
    network: { type: String, required: true },
    address: String,
    lease: String,
    until: Date,
  },
  { timestamps: true, versionKey: false },
)
schema.index(
  { address: 1, network: 1 },
  { unique: true, partialFilterExpression: { address: { $type: "string" } } },
)
const Checkout = mongoose.model<Doc>("PosOnChainCheckoutRecord", schema)
const duplicate = (err: unknown) => (err as { code?: number })?.code === 11000
let ready: Promise<unknown> | undefined
function ensureIndex() {
  // Production may disable autoIndex. Never publish a checkout without the uniqueness constraint.
  return (ready ??= Checkout.createIndexes().catch((error) => {
    ready = undefined
    throw error
  }))
}
export const posOnChainStore: Store = {
  async read(key) {
    await ensureIndex()
    return Checkout.findById(key).lean().exec()
  },
  async reserve(row) {
    await ensureIndex()
    try {
      await Checkout.create(row)
    } catch (err) {
      if (!duplicate(err)) throw err
    }
  },
  async claim(key, lease) {
    const now = new Date()
    const r = await Checkout.updateOne(
      {
        _id: key,
        address: { $exists: false },
        $or: [{ until: { $exists: false } }, { until: { $lt: now } }],
      },
      { $set: { lease, until: new Date(now.getTime() + 60000) } },
    )
    return r.modifiedCount === 1
  },
  async publish(key, lease, address) {
    const r = await Checkout.updateOne(
      { _id: key, lease, address: { $exists: false } },
      { $set: { address }, $unset: { lease: 1, until: 1 } },
    )
    return r.modifiedCount === 1
  },
  async release(key, lease) {
    await Checkout.updateOne({ _id: key, lease }, { $unset: { lease: 1, until: 1 } })
  },
}
