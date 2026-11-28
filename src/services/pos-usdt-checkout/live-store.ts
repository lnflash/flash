import mongoose from "mongoose"

import type { LiveDoc, LiveStore, Slot } from "@app/pos-usdt-checkout/live-updates"

/**
 * Live update enrollments and their outbox state, one document per receipt,
 * in their own collection: nothing here shares a document, index or write
 * with the checkout rows or credits. Push tokens are stored sealed only, and
 * wiped as soon as a device is done; the TTL index purges each document at
 * `expiresAt` (follow window + retention).
 */

type SlotDoc = Slot
type Doc = Omit<LiveDoc, "nextAt" | "expiresAt"> & {
  nextAt: Date
  expiresAt: Date
  lease?: string
  leaseUntil?: Date
}

const slotSchema = new mongoose.Schema<SlotDoc>(
  {
    id: { type: String, required: true },
    seq: { type: Number, required: true },
    state: { type: String, required: true },
    sealed: String,
    tokenDigest: String,
    sentRank: { type: Number, required: true },
    lastTimestamp: { type: Number, required: true },
    lastSentAt: Number,
    attempts: { type: Number, required: true },
    nextAt: { type: Number, required: true },
  },
  // `id` is a stored path here, not mongoose's virtual.
  { _id: false, id: false, versionKey: false },
)

const schema = new mongoose.Schema<Doc>(
  {
    _id: String,
    version: { type: Number, required: true },
    createdAt: { type: Number, required: true },
    followUntil: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    stage: { type: Number, required: true },
    slots: { type: [slotSchema], default: [] },
    slotsCreated: { type: Number, required: true },
    nextAt: { type: Date, required: true },
    done: { type: Boolean, required: true },
    lease: String,
    leaseUntil: Date,
  },
  { versionKey: false, timestamps: false },
)
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
schema.index({ done: 1, nextAt: 1 })

export const PosUsdtLiveUpdate = mongoose.model<Doc>("PosUsdtLiveUpdate", schema)

let ready: Promise<unknown> | undefined
const ensureIndexes = () =>
  (ready ??= PosUsdtLiveUpdate.createIndexes().catch((error) => {
    ready = undefined
    throw error
  }))

const duplicate = (err: unknown) => (err as { code?: number })?.code === 11000

const fromDoc = (d: Doc): LiveDoc => ({
  _id: d._id,
  version: d.version,
  createdAt: d.createdAt,
  followUntil: d.followUntil,
  expiresAt: new Date(d.expiresAt).getTime(),
  stage: d.stage,
  slots: (d.slots ?? []).map((s) => ({ ...s })),
  slotsCreated: d.slotsCreated,
  nextAt: new Date(d.nextAt).getTime(),
  done: d.done,
})

const fields = (doc: LiveDoc) => ({
  createdAt: doc.createdAt,
  followUntil: doc.followUntil,
  expiresAt: new Date(doc.expiresAt),
  stage: doc.stage,
  slots: doc.slots,
  slotsCreated: doc.slotsCreated,
  nextAt: new Date(doc.nextAt),
  done: doc.done,
})

export const posUsdtLiveStore: LiveStore = {
  async load(key) {
    await ensureIndexes()
    const d = await PosUsdtLiveUpdate.findById(key).lean<Doc>().exec()
    return d ? fromDoc(d) : null
  },
  async save(doc) {
    await ensureIndexes()
    if (doc.version === 0) {
      try {
        await PosUsdtLiveUpdate.create({ _id: doc._id, version: 1, ...fields(doc) })
        return true
      } catch (err) {
        if (duplicate(err)) return false
        throw err
      }
    }
    const r = await PosUsdtLiveUpdate.updateOne(
      { _id: { $eq: doc._id }, version: { $eq: doc.version } },
      { $set: { ...fields(doc), version: doc.version + 1 } },
    )
    return r.modifiedCount === 1
  },
  async claimDue(now, lease, leaseMs, limit) {
    await ensureIndexes()
    const at = new Date(now)
    const keys: string[] = []
    for (let i = 0; i < limit; i++) {
      const d = await PosUsdtLiveUpdate.findOneAndUpdate(
        {
          done: false,
          nextAt: { $lte: at },
          $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: at } }],
        },
        { $set: { lease, leaseUntil: new Date(now + leaseMs) } },
        { sort: { nextAt: 1 }, projection: { _id: 1 }, new: true },
      )
        .lean<{ _id: string }>()
        .exec()
      if (!d) break
      keys.push(d._id)
    }
    return keys
  },
  async release(key, lease) {
    await PosUsdtLiveUpdate.updateOne(
      { _id: { $eq: key }, lease: { $eq: lease } },
      { $unset: { lease: 1, leaseUntil: 1 } },
    )
  },
}
