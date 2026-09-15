/**
 * Repository behaviour with the model mocked: what query `transition` issues,
 * how a non-matching conditional update is disambiguated into "not found" vs
 * "wrong state", and how a duplicate idempotency key on `create` is surfaced.
 * The index- and race-shaped claims are checked against a real collection in
 * test/flash/integration/gift-cards/gift-card-orders.spec.ts.
 */
import { DuplicateKeyForPersistError, UnknownRepositoryError } from "@domain/errors"
import {
  GiftCardOrderNotFoundError,
  GiftCardOrderStateError,
  GiftCardOrderStatus,
  toGiftCardOrderId,
} from "@domain/gift-cards"
import {
  GiftCardOrderDuplicateKeyError,
  GiftCardOrdersRepository,
} from "@services/mongoose/gift-card-orders"

const create = jest.fn()
const findOne = jest.fn()
const findOneAndUpdate = jest.fn()
const find = jest.fn()
const updateOne = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  GiftCardOrders: {
    create: (...args: unknown[]) => create(...args),
    findOne: (...args: unknown[]) => findOne(...args),
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
    find: (...args: unknown[]) => find(...args),
    updateOne: (...args: unknown[]) => updateOne(...args),
  },
}))

const ORDER_ID = toGiftCardOrderId("1f9d2c4e-8b7a-4c3d-9e2f-0a1b2c3d4e5f")
const NOW = new Date("2026-09-09T12:00:00.000Z")

const record = (overrides: Partial<GiftCardOrderRecord> = {}): GiftCardOrderRecord => ({
  id: ORDER_ID,
  accountId: "acc",
  walletId: "wal",
  walletCurrency: "USD",
  providerId: "bitcoinCompany",
  providerProductId: "amazon-us",
  providerOrderId: null,
  productSnapshot: {
    name: "Amazon.com",
    brand: "Amazon",
    countryCode: "US",
    currency: "USD",
    isOpenLoop: false,
    logoUrl: null,
  },
  valueMinor: 2500,
  currency: "USD",
  quantity: 1,
  quoteSats: 41234,
  invoiceSats: null,
  paidSats: null,
  paymentRequest: null,
  paymentHash: null,
  providerPaymentRef: null,
  idempotencyKey: "idem-0001",
  status: "CREATED",
  statusHistory: [{ status: "CREATED", at: NOW, reason: null }],
  claimCiphertext: null,
  claimKeyId: null,
  fulfilledAt: null,
  failureReason: null,
  expiresAt: new Date("2026-09-09T12:15:00.000Z"),
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
})

const chain = (result: unknown) => {
  const limit = jest.fn().mockResolvedValue(result)
  const sort = jest.fn(() => ({ limit }))
  find.mockReturnValue({ sort })
  return { sort, limit }
}

describe("GiftCardOrdersRepository", () => {
  beforeEach(() => {
    create.mockReset()
    findOne.mockReset()
    findOneAndUpdate.mockReset()
    find.mockReset()
    updateOne.mockReset()
  })

  describe("create", () => {
    const args = {
      accountId: "acc" as AccountId,
      walletId: "wal" as WalletId,
      walletCurrency: "USD" as WalletCurrency,
      providerId: "bitcoinCompany" as GiftCardProviderId,
      providerProductId: "amazon-us",
      productSnapshot: {
        name: "Amazon.com",
        brand: "Amazon",
        countryCode: "US",
        currency: "USD",
        isOpenLoop: false,
        logoUrl: null,
      },
      valueMinor: 2500,
      currency: "USD",
      quantity: 1,
      quoteSats: 41234 as Satoshis,
      idempotencyKey: "idem-0001",
      expiresAt: new Date("2026-09-09T12:15:00.000Z"),
    }

    it("seeds status CREATED with a single history entry and a fresh uuid", async () => {
      create.mockImplementation(async (doc) => doc)

      const result = await GiftCardOrdersRepository().create(args)

      expect(create).toHaveBeenCalledTimes(1)
      const written = create.mock.calls[0][0]
      expect(written.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      expect(written.status).toBe(GiftCardOrderStatus.Created)
      expect(written.statusHistory).toHaveLength(1)
      expect(written.statusHistory[0]).toMatchObject({
        status: GiftCardOrderStatus.Created,
        reason: null,
      })
      expect(written.statusHistory[0].at).toBeInstanceOf(Date)
      expect(written.createdAt).toBe(written.updatedAt)
      // Nothing vendor-side yet.
      expect(written.providerOrderId).toBeNull()
      expect(written.paymentRequest).toBeNull()
      expect(written.claimCiphertext).toBeNull()

      expect(result).not.toBeInstanceOf(Error)
      expect((result as GiftCardOrder).status).toBe(GiftCardOrderStatus.Created)
      expect((result as GiftCardOrder).idempotencyKey).toBe("idem-0001")
    })

    it("surfaces a duplicate idempotency key as GiftCardOrderDuplicateKeyError", async () => {
      create.mockRejectedValue(
        new Error(
          'E11000 duplicate key error collection: galoy.giftcardorders index: walletId_1_idempotencyKey_1 dup key: { walletId: "wal", idempotencyKey: "idem-0001" }',
        ),
      )

      const result = await GiftCardOrdersRepository().create(args)

      expect(result).toBeInstanceOf(GiftCardOrderDuplicateKeyError)
    })

    it("leaves a duplicate on another index as the generic duplicate error", async () => {
      create.mockRejectedValue(
        new Error(
          'E11000 duplicate key error collection: galoy.giftcardorders index: id_1 dup key: { id: "x" }',
        ),
      )

      const result = await GiftCardOrdersRepository().create(args)

      expect(result).toBeInstanceOf(DuplicateKeyForPersistError)
      expect(result).not.toBeInstanceOf(GiftCardOrderDuplicateKeyError)
    })

    it("returns, never throws, on an unknown driver error", async () => {
      create.mockRejectedValue(new Error("something else"))

      const result = await GiftCardOrdersRepository().create(args)

      expect(result).toBeInstanceOf(UnknownRepositoryError)
    })
  })

  describe("find*", () => {
    it("findById maps a hit and reports a miss as GiftCardOrderNotFoundError", async () => {
      findOne.mockResolvedValueOnce(record())
      const hit = await GiftCardOrdersRepository().findById(ORDER_ID)
      expect(findOne).toHaveBeenCalledWith({ id: { $eq: ORDER_ID } })
      expect((hit as GiftCardOrder).id).toBe(ORDER_ID)

      findOne.mockResolvedValueOnce(null)
      const miss = await GiftCardOrdersRepository().findById(ORDER_ID)
      expect(miss).toBeInstanceOf(GiftCardOrderNotFoundError)
    })

    it("findByIdempotencyKey scopes to the wallet", async () => {
      findOne.mockResolvedValueOnce(record())

      await GiftCardOrdersRepository().findByIdempotencyKey({
        walletId: "wal" as WalletId,
        idempotencyKey: "idem-0001",
      })

      expect(findOne).toHaveBeenCalledWith({
        walletId: { $eq: "wal" },
        idempotencyKey: { $eq: "idem-0001" },
      })
    })

    it("findByProviderOrderId scopes to the provider", async () => {
      findOne.mockResolvedValueOnce(null)

      const result = await GiftCardOrdersRepository().findByProviderOrderId({
        providerId: "bitcoinCompany",
        providerOrderId: "tbc_1" as GiftCardProviderOrderId,
      })

      expect(findOne).toHaveBeenCalledWith({
        providerId: { $eq: "bitcoinCompany" },
        providerOrderId: { $eq: "tbc_1" },
      })
      expect(result).toBeInstanceOf(GiftCardOrderNotFoundError)
    })
  })

  describe("list*", () => {
    it("listByAccount is newest first and pages by createdAt", async () => {
      const { sort, limit } = chain([record()])
      const before = new Date("2026-09-09T11:00:00.000Z")

      const result = await GiftCardOrdersRepository().listByAccount({
        accountId: "acc" as AccountId,
        limit: 20,
        before,
      })

      expect(find).toHaveBeenCalledWith({
        accountId: { $eq: "acc" },
        createdAt: { $lt: before },
      })
      expect(sort).toHaveBeenCalledWith({ createdAt: -1 })
      expect(limit).toHaveBeenCalledWith(20)
      expect(result).toHaveLength(1)
    })

    it("listByAccount omits the createdAt filter without a cursor", async () => {
      chain([])

      await GiftCardOrdersRepository().listByAccount({
        accountId: "acc" as AccountId,
        limit: 5,
      })

      expect(find).toHaveBeenCalledWith({ accountId: { $eq: "acc" } })
    })

    it("listByStatus is oldest updatedAt first", async () => {
      const { sort, limit } = chain([record({ status: "PAID" })])
      const updatedBefore = new Date("2026-09-09T11:00:00.000Z")

      const result = await GiftCardOrdersRepository().listByStatus({
        statuses: [GiftCardOrderStatus.Paid, GiftCardOrderStatus.InvoiceIssued],
        updatedBefore,
        limit: 50,
      })

      expect(find).toHaveBeenCalledWith({
        status: { $in: ["PAID", "INVOICE_ISSUED"] },
        updatedAt: { $lt: updatedBefore },
      })
      expect(sort).toHaveBeenCalledWith({ updatedAt: 1 })
      expect(limit).toHaveBeenCalledWith(50)
      expect((result as GiftCardOrder[])[0].status).toBe("PAID")
    })
  })

  describe("touch", () => {
    // The reconcile worker bumps `updatedAt` after a poll that changed nothing,
    // so `listByStatus` (oldest `updatedAt` first) rotates through a batch
    // instead of pinning the same stuck rows at its front run after run.
    it("sets only updatedAt, by id, and changes nothing else", async () => {
      updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })

      const result = await GiftCardOrdersRepository().touch(ORDER_ID)

      expect(result).toBe(true)
      expect(updateOne).toHaveBeenCalledTimes(1)
      const [filter, update] = updateOne.mock.calls[0]
      expect(filter).toEqual({ id: { $eq: ORDER_ID } })
      expect(Object.keys(update)).toEqual(["$set"])
      expect(Object.keys(update.$set)).toEqual(["updatedAt"])
      expect(update.$set.updatedAt).toBeInstanceOf(Date)
      // No status, no history entry: a touch is not a transition.
      expect(findOneAndUpdate).not.toHaveBeenCalled()
    })

    it("reports not-found when no row matched", async () => {
      updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 })

      const result = await GiftCardOrdersRepository().touch(ORDER_ID)

      expect(result).toBeInstanceOf(GiftCardOrderNotFoundError)
    })

    it("returns a repository error rather than throwing", async () => {
      updateOne.mockRejectedValue(new Error("connection closed"))

      const result = await GiftCardOrdersRepository().touch(ORDER_ID)

      expect(result).toBeInstanceOf(UnknownRepositoryError)
    })
  })

  describe("transition", () => {
    it("is one conditional findOneAndUpdate on the current status", async () => {
      findOneAndUpdate.mockResolvedValue(
        record({
          status: "INVOICE_ISSUED",
          paymentRequest: "lnbc1...",
          invoiceSats: 41300,
        }),
      )

      const result = await GiftCardOrdersRepository().transition({
        id: ORDER_ID,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.InvoiceIssued,
        reason: "vendor invoice",
        patch: { paymentRequest: "lnbc1...", invoiceSats: 41300 as Satoshis },
      })

      expect(findOneAndUpdate).toHaveBeenCalledTimes(1)
      const [filter, update, options] = findOneAndUpdate.mock.calls[0]
      expect(filter).toEqual({ id: { $eq: ORDER_ID }, status: { $in: ["CREATED"] } })
      expect(update.$set).toMatchObject({
        paymentRequest: "lnbc1...",
        invoiceSats: 41300,
        status: "INVOICE_ISSUED",
      })
      expect(update.$set.updatedAt).toBeInstanceOf(Date)
      expect(update.$push.statusHistory).toMatchObject({
        status: "INVOICE_ISSUED",
        reason: "vendor invoice",
      })
      expect(update.$push.statusHistory.at).toBe(update.$set.updatedAt)
      expect(options).toEqual({ new: true })
      // Nothing else was read: the matched document is the answer.
      expect(findOne).not.toHaveBeenCalled()
      expect((result as GiftCardOrder).status).toBe("INVOICE_ISSUED")
    })

    it("records a null reason when none is given", async () => {
      findOneAndUpdate.mockResolvedValue(record({ status: "PAID" }))

      await GiftCardOrdersRepository().transition({
        id: ORDER_ID,
        from: [GiftCardOrderStatus.InvoiceIssued, GiftCardOrderStatus.PaymentPending],
        to: GiftCardOrderStatus.Paid,
      })

      const [filter, update] = findOneAndUpdate.mock.calls[0]
      expect(filter.status).toEqual({ $in: ["INVOICE_ISSUED", "PAYMENT_PENDING"] })
      expect(update.$push.statusHistory.reason).toBeNull()
    })

    it("refuses an illegal from → to before touching Mongo", async () => {
      const result = await GiftCardOrdersRepository().transition({
        id: ORDER_ID,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.Paid,
      })

      expect(result).toBeInstanceOf(GiftCardOrderStateError)
      expect((result as Error).message).toBe("cannot move CREATED → PAID")
      expect(findOneAndUpdate).not.toHaveBeenCalled()
      expect(findOne).not.toHaveBeenCalled()
    })

    it("reports not-found when nothing matched and the order does not exist", async () => {
      findOneAndUpdate.mockResolvedValue(null)
      findOne.mockResolvedValue(null)

      const result = await GiftCardOrdersRepository().transition({
        id: ORDER_ID,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.InvoiceIssued,
      })

      expect(result).toBeInstanceOf(GiftCardOrderNotFoundError)
      expect(findOne).toHaveBeenCalledWith({ id: { $eq: ORDER_ID } })
    })

    it("reports the current state when nothing matched because the order moved on", async () => {
      // A second worker already took CREATED → INVOICE_ISSUED.
      findOneAndUpdate.mockResolvedValue(null)
      findOne.mockResolvedValue(record({ status: "INVOICE_ISSUED" }))

      const result = await GiftCardOrdersRepository().transition({
        id: ORDER_ID,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.InvoiceIssued,
      })

      expect(result).toBeInstanceOf(GiftCardOrderStateError)
      expect((result as Error).message).toBe(
        "cannot move INVOICE_ISSUED → INVOICE_ISSUED",
      )
    })

    it("returns, never throws, on a driver error", async () => {
      findOneAndUpdate.mockRejectedValue(new Error("connection 1 to mongo:27017 closed"))

      const result = await GiftCardOrdersRepository().transition({
        id: ORDER_ID,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.Failed,
      })

      expect(result).toBeInstanceOf(Error)
      expect(result).not.toBeInstanceOf(GiftCardOrderStateError)
    })
  })
})
