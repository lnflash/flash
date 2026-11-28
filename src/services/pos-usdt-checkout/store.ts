import mongoose from "mongoose"

import { CollisionError, Credit, Row, Store } from "@app/pos-usdt-checkout/checkout"

// A receive info or address is never reallocated, paid or not.
type CheckoutDoc = Row & { lease?: string; until?: Date }
const checkoutSchema = new mongoose.Schema<CheckoutDoc>(
  {
    _id: String,
    recipientWalletId: { type: String, required: true },
    settlementWalletId: String,
    amountMinor: { type: Number, required: true },
    network: { type: String, required: true },
    receiveInfoId: String,
    address: String,
    candidate: {
      type: new mongoose.Schema(
        { receiveInfoId: String, address: String },
        { _id: false, versionKey: false },
      ),
      default: undefined,
    },
    attempt: String,
    failed: String,
    lease: String,
    until: Date,
  },
  { timestamps: true, versionKey: false },
)
checkoutSchema.index(
  { receiveInfoId: 1 },
  { unique: true, partialFilterExpression: { receiveInfoId: { $type: "string" } } },
)
checkoutSchema.index(
  { address: 1, network: 1 },
  { unique: true, partialFilterExpression: { address: { $type: "string" } } },
)

type CreditDoc = Credit
const creditSchema = new mongoose.Schema<CreditDoc>(
  {
    _id: String,
    checkoutKey: { type: String, required: true, index: true },
    receiveInfoId: { type: String, required: true },
    walletId: { type: String, required: true },
    txid: { type: String, required: true },
    amountMicro: { type: String, required: true },
    state: { type: String, required: true },
    checkedAt: Date,
  },
  { timestamps: true, versionKey: false },
)

const Checkout = mongoose.model<CheckoutDoc>("PosUsdtCheckoutRecord", checkoutSchema)
const CreditRecord = mongoose.model<CreditDoc>("PosUsdtCheckoutCredit", creditSchema)
export { Checkout as PosUsdtCheckoutRecord, CreditRecord as PosUsdtCheckoutCredit }

const LEASE_MS = 60_000
// A pending credit is read back from IBEX at most this often.
const RECHECK_MS = 15_000

const duplicate = (err: unknown) => (err as { code?: number })?.code === 11000
let ready: Promise<unknown> | undefined
function ensureIndexes() {
  // Production may disable autoIndex. Never publish without the uniqueness constraints.
  return (ready ??= Promise.all([
    Checkout.createIndexes(),
    CreditRecord.createIndexes(),
  ]).catch((error) => {
    ready = undefined
    throw error
  }))
}

const unpublished = { address: { $exists: false }, failed: { $exists: false } }

const toCredit = (doc: CreditDoc): Credit => ({
  _id: doc._id,
  checkoutKey: doc.checkoutKey,
  receiveInfoId: doc.receiveInfoId,
  walletId: doc.walletId,
  txid: doc.txid,
  amountMicro: doc.amountMicro,
  state: doc.state,
  // Read so a status poll can take the least recently checked credits first.
  ...(doc.checkedAt ? { checkedAt: doc.checkedAt } : {}),
})

export const posUsdtStore: Store = {
  async read(key) {
    await ensureIndexes()
    return Checkout.findById(key).lean().exec()
  },
  async findByReceiveInfo(receiveInfoId) {
    await ensureIndexes()
    return Checkout.findOne({
      receiveInfoId: { $eq: receiveInfoId },
      address: { $type: "string" },
    })
      .lean()
      .exec()
  },
  async reserve(row) {
    await ensureIndexes()
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
        ...unpublished,
        $or: [{ until: { $exists: false } }, { until: { $lt: now } }],
      },
      { $set: { lease, until: new Date(now.getTime() + LEASE_MS) } },
    )
    return r.modifiedCount === 1
  },
  async begin(key, lease, attempt) {
    const r = await Checkout.updateOne(
      {
        _id: key,
        lease,
        ...unpublished,
        attempt: { $exists: false },
        candidate: { $exists: false },
      },
      { $set: { attempt } },
    )
    return r.modifiedCount === 1
  },
  async abandon(key, lease, attempt) {
    await Checkout.updateOne({ _id: key, lease, attempt }, { $unset: { attempt: 1 } })
  },
  async stage(key, lease, attempt, allocation) {
    const r = await Checkout.updateOne(
      { _id: key, lease, attempt, ...unpublished },
      { $set: { candidate: allocation }, $unset: { attempt: 1 } },
    )
    return r.modifiedCount === 1
  },
  async fail(key, reason) {
    await Checkout.updateOne({ _id: key, ...unpublished }, { $set: { failed: reason } })
  },
  async publish(key, lease, allocation) {
    try {
      const r = await Checkout.updateOne(
        { _id: key, lease, ...unpublished },
        {
          $set: { receiveInfoId: allocation.receiveInfoId, address: allocation.address },
          $unset: { lease: 1, until: 1, candidate: 1, attempt: 1 },
        },
      )
      return r.modifiedCount === 1
    } catch (err) {
      // A unique index: another sale holds this receive info or address.
      if (duplicate(err)) throw new CollisionError()
      throw err
    }
  },
  async release(key, lease) {
    await Checkout.updateOne({ _id: key, lease }, { $unset: { lease: 1, until: 1 } })
  },
  async credits(key) {
    await ensureIndexes()
    const docs = await CreditRecord.find({ checkoutKey: { $eq: key } })
      .lean()
      .exec()
    return docs.map(toCredit)
  },
  async addCredit(credit) {
    await ensureIndexes()
    try {
      await CreditRecord.create(credit)
      return credit
    } catch (err) {
      if (!duplicate(err)) throw err
    }
    const existing = await CreditRecord.findById(credit._id).lean().exec()
    if (!existing) throw new Error("POS USDT credit vanished after a duplicate insert")
    return toCredit(existing)
  },
  async post(transactionId, expected) {
    await CreditRecord.updateOne(
      {
        _id: transactionId,
        state: "DETECTED",
        checkoutKey: expected.checkoutKey,
        amountMicro: expected.amountMicro,
        txid: expected.txid,
        walletId: expected.walletId,
      },
      { $set: { state: "POSTED" } },
    )
  },
  async touch(transactionId) {
    const now = new Date()
    const r = await CreditRecord.updateOne(
      {
        _id: transactionId,
        state: "DETECTED",
        $or: [
          { checkedAt: { $exists: false } },
          { checkedAt: { $lt: new Date(now.getTime() - RECHECK_MS) } },
        ],
      },
      { $set: { checkedAt: now } },
    )
    return r.modifiedCount === 1
  },
}
