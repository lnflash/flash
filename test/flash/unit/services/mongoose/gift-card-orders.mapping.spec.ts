/**
 * The pure half of the gift card orders repository: record → domain mapping,
 * the transition table check that runs before any write, and the duplicate-key
 * attribution that tells a client retry apart from a real index collision.
 * None of this touches mongoose, so every case here runs without a database.
 */
import { DuplicateKeyForPersistError, RepositoryError } from "@domain/errors"
import {
  GIFT_CARD_TRANSITIONS,
  GiftCardOrderStateError,
  GiftCardOrderStatus,
} from "@domain/gift-cards"
import {
  GIFT_CARD_ORDER_IDEMPOTENCY_INDEX,
  GiftCardOrderDuplicateKeyError,
  checkGiftCardOrderTransition,
  isGiftCardOrderIdempotencyDuplicate,
  toDomain,
} from "@services/mongoose/gift-card-orders.mapping"

const CREATED_AT = new Date("2026-09-09T12:00:00.000Z")
const UPDATED_AT = new Date("2026-09-09T12:05:00.000Z")
const EXPIRES_AT = new Date("2026-09-09T12:15:00.000Z")
const FULFILLED_AT = new Date("2026-09-09T12:04:30.000Z")

const fullRecord: GiftCardOrderRecord = {
  id: "1f9d2c4e-8b7a-4c3d-9e2f-0a1b2c3d4e5f",
  accountId: "5f4c9a2b1e7d3f8a6b0c4d2e",
  walletId: "7d2e1b9a-3c4f-4a5b-8c6d-9e0f1a2b3c4d",
  walletCurrency: "USD",
  providerId: "bitcoinCompany",
  providerProductId: "amazon-us",
  providerOrderId: "tbc_ord_123",
  productSnapshot: {
    name: "Amazon.com",
    brand: "Amazon",
    countryCode: "US",
    currency: "USD",
    isOpenLoop: false,
    logoUrl: "https://cdn.example.test/amazon.png",
  },
  valueMinor: 2500,
  currency: "USD",
  quantity: 1,
  quoteSats: 41234,
  invoiceSats: 41300,
  paidSats: 41300,
  paymentRequest: "lnbc413000n1...",
  paymentHash: "a".repeat(64),
  providerPaymentRef: "ibex_tx_123",
  idempotencyKey: "idem-0001",
  status: "FULFILLED",
  statusHistory: [
    { status: "CREATED", at: CREATED_AT, reason: null },
    { status: "INVOICE_ISSUED", at: new Date("2026-09-09T12:01:00.000Z"), reason: null },
    { status: "PAID", at: new Date("2026-09-09T12:03:00.000Z"), reason: "ibex settled" },
    { status: "FULFILLED", at: FULFILLED_AT, reason: null },
  ],
  claimCiphertext: "AQ...base64...",
  claimKeyId: "0123456789abcdef",
  fulfilledAt: FULFILLED_AT,
  failureReason: null,
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
}

describe("toDomain", () => {
  it("maps a fully populated record field for field", () => {
    const order = toDomain(fullRecord)

    expect(order).toEqual({
      id: fullRecord.id,
      accountId: fullRecord.accountId,
      walletId: fullRecord.walletId,
      walletCurrency: "USD",
      providerId: "bitcoinCompany",
      providerProductId: "amazon-us",
      providerOrderId: "tbc_ord_123",
      productSnapshot: {
        name: "Amazon.com",
        brand: "Amazon",
        countryCode: "US",
        currency: "USD",
        isOpenLoop: false,
        logoUrl: "https://cdn.example.test/amazon.png",
      },
      valueMinor: 2500,
      currency: "USD",
      quantity: 1,
      quoteSats: 41234,
      invoiceSats: 41300,
      paidSats: 41300,
      paymentRequest: "lnbc413000n1...",
      paymentHash: "a".repeat(64),
      providerPaymentRef: "ibex_tx_123",
      idempotencyKey: "idem-0001",
      status: GiftCardOrderStatus.Fulfilled,
      statusHistory: [
        { status: "CREATED", at: CREATED_AT, reason: null },
        {
          status: "INVOICE_ISSUED",
          at: new Date("2026-09-09T12:01:00.000Z"),
          reason: null,
        },
        {
          status: "PAID",
          at: new Date("2026-09-09T12:03:00.000Z"),
          reason: "ibex settled",
        },
        { status: "FULFILLED", at: FULFILLED_AT, reason: null },
      ],
      claimCiphertext: "AQ...base64...",
      claimKeyId: "0123456789abcdef",
      fulfilledAt: FULFILLED_AT,
      failureReason: null,
      expiresAt: EXPIRES_AT,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    })
  })

  it("keeps Date instances as Dates and numbers as numbers", () => {
    const order = toDomain(fullRecord)

    expect(order.createdAt).toBeInstanceOf(Date)
    expect(order.updatedAt).toBeInstanceOf(Date)
    expect(order.expiresAt).toBeInstanceOf(Date)
    expect(order.fulfilledAt).toBeInstanceOf(Date)
    expect(order.statusHistory[0].at).toBeInstanceOf(Date)
    expect(typeof order.valueMinor).toBe("number")
    expect(typeof order.quoteSats).toBe("number")
    expect(typeof order.invoiceSats).toBe("number")
    expect(typeof order.quantity).toBe("number")
  })

  it("normalises missing optional fields to null on a freshly created record", () => {
    const fresh: GiftCardOrderRecord = {
      id: fullRecord.id,
      accountId: fullRecord.accountId,
      walletId: fullRecord.walletId,
      walletCurrency: "USD",
      providerId: "bitcoinCompany",
      providerProductId: "amazon-us",
      // Everything nullable left unset, as a legacy or partially written
      // document would have it.
      productSnapshot: {
        name: "Amazon.com",
        brand: "Amazon",
        countryCode: "US",
        currency: "USD",
        isOpenLoop: false,
      },
      valueMinor: 2500,
      currency: "USD",
      quantity: 1,
      quoteSats: 41234,
      idempotencyKey: "idem-0001",
      status: "CREATED",
      statusHistory: [{ status: "CREATED", at: CREATED_AT }],
      expiresAt: EXPIRES_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }

    const order = toDomain(fresh)

    expect(order.providerOrderId).toBeNull()
    expect(order.productSnapshot.logoUrl).toBeNull()
    expect(order.invoiceSats).toBeNull()
    expect(order.paidSats).toBeNull()
    expect(order.paymentRequest).toBeNull()
    expect(order.paymentHash).toBeNull()
    expect(order.providerPaymentRef).toBeNull()
    expect(order.claimCiphertext).toBeNull()
    expect(order.claimKeyId).toBeNull()
    expect(order.fulfilledAt).toBeNull()
    expect(order.failureReason).toBeNull()
    expect(order.statusHistory).toEqual([
      { status: "CREATED", at: CREATED_AT, reason: null },
    ])
  })

  it("treats an explicit null providerOrderId as null, and an empty history as []", () => {
    const order = toDomain({
      ...fullRecord,
      providerOrderId: null,
      statusHistory: undefined as unknown as GiftCardOrderStatusHistoryRecord[],
    })

    expect(order.providerOrderId).toBeNull()
    expect(order.statusHistory).toEqual([])
  })

  it("does not leak extra record fields onto the domain object", () => {
    const order = toDomain({
      ...fullRecord,
      _id: "mongo-object-id",
      __v: 3,
    } as GiftCardOrderRecord)

    expect(order).not.toHaveProperty("_id")
    expect(order).not.toHaveProperty("__v")
  })
})

describe("checkGiftCardOrderTransition", () => {
  const allStatuses = Object.values(GiftCardOrderStatus)

  const legalPairs = allStatuses.flatMap((from) =>
    GIFT_CARD_TRANSITIONS[from].map((to) => [from, to] as const),
  )

  const illegalPairs = allStatuses.flatMap((from) =>
    allStatuses
      .filter((to) => !GIFT_CARD_TRANSITIONS[from].includes(to))
      .map((to) => [from, to] as const),
  )

  it("derives a non-trivial table from the domain", () => {
    expect(legalPairs.length).toBeGreaterThan(0)
    expect(illegalPairs.length).toBeGreaterThan(0)
  })

  it.each(legalPairs)("allows %s → %s", (from, to) => {
    expect(checkGiftCardOrderTransition([from], to)).toBe(true)
  })

  it.each(illegalPairs)("refuses %s → %s", (from, to) => {
    const result = checkGiftCardOrderTransition([from], to)
    expect(result).toBeInstanceOf(GiftCardOrderStateError)
    expect((result as Error).message).toBe(`cannot move ${from} → ${to}`)
  })

  it("allows a multi-source transition when every source is legal", () => {
    expect(
      checkGiftCardOrderTransition(
        [GiftCardOrderStatus.InvoiceIssued, GiftCardOrderStatus.PaymentPending],
        GiftCardOrderStatus.Paid,
      ),
    ).toBe(true)
  })

  it("refuses a multi-source transition when any one source is illegal", () => {
    const result = checkGiftCardOrderTransition(
      [GiftCardOrderStatus.InvoiceIssued, GiftCardOrderStatus.Created],
      GiftCardOrderStatus.Paid,
    )
    expect(result).toBeInstanceOf(GiftCardOrderStateError)
    expect((result as Error).message).toBe("cannot move CREATED → PAID")
  })

  it("refuses an empty source list", () => {
    expect(checkGiftCardOrderTransition([], GiftCardOrderStatus.Paid)).toBeInstanceOf(
      GiftCardOrderStateError,
    )
  })

  it("refuses unknown statuses instead of throwing", () => {
    expect(
      checkGiftCardOrderTransition(
        ["BOGUS" as GiftCardOrderStatus],
        GiftCardOrderStatus.Paid,
      ),
    ).toBeInstanceOf(GiftCardOrderStateError)
    expect(
      checkGiftCardOrderTransition(
        [GiftCardOrderStatus.Created],
        "BOGUS" as GiftCardOrderStatus,
      ),
    ).toBeInstanceOf(GiftCardOrderStateError)
  })

  it("never lets a terminal state move anywhere", () => {
    const terminal = [
      GiftCardOrderStatus.Fulfilled,
      GiftCardOrderStatus.Failed,
      GiftCardOrderStatus.PaymentFailed,
      GiftCardOrderStatus.Expired,
      GiftCardOrderStatus.RefundRequired,
    ]
    for (const from of terminal) {
      for (const to of allStatuses) {
        expect(checkGiftCardOrderTransition([from], to)).toBeInstanceOf(
          GiftCardOrderStateError,
        )
      }
    }
  })
})

describe("isGiftCardOrderIdempotencyDuplicate", () => {
  const idempotencyDriverMessage = `E11000 duplicate key error collection: galoy.giftcardorders index: ${GIFT_CARD_ORDER_IDEMPOTENCY_INDEX} dup key: { walletId: "w1", idempotencyKey: "k1" }`

  it("recognises the driver message for the idempotency index", () => {
    expect(isGiftCardOrderIdempotencyDuplicate(new Error(idempotencyDriverMessage))).toBe(
      true,
    )
  })

  it("recognises the structured driver error by code + keyPattern", () => {
    const err = Object.assign(new Error("E11000 duplicate key error"), {
      code: 11000,
      keyPattern: { walletId: 1, idempotencyKey: 1 },
    })
    expect(isGiftCardOrderIdempotencyDuplicate(err)).toBe(true)
  })

  it("does not claim a duplicate on a different index", () => {
    const providerDup = new Error(
      'E11000 duplicate key error collection: galoy.giftcardorders index: providerId_1_providerOrderId_1 dup key: { providerId: "bitcoinCompany", providerOrderId: "x" }',
    )
    expect(isGiftCardOrderIdempotencyDuplicate(providerDup)).toBe(false)

    const structured = Object.assign(new Error("E11000 duplicate key error"), {
      code: 11000,
      keyPattern: { providerId: 1, providerOrderId: 1 },
    })
    expect(isGiftCardOrderIdempotencyDuplicate(structured)).toBe(false)
  })

  it("does not claim a duplicate on unrelated errors", () => {
    expect(isGiftCardOrderIdempotencyDuplicate(new Error("connection closed"))).toBe(
      false,
    )
    expect(isGiftCardOrderIdempotencyDuplicate(null)).toBe(false)
    expect(isGiftCardOrderIdempotencyDuplicate(undefined)).toBe(false)
    expect(isGiftCardOrderIdempotencyDuplicate("walletId_1_idempotencyKey_1")).toBe(false)
  })

  it("exposes a RepositoryError subclass distinct from the generic duplicate error", () => {
    const err = new GiftCardOrderDuplicateKeyError("dup")
    expect(err).toBeInstanceOf(RepositoryError)
    expect(err).not.toBeInstanceOf(DuplicateKeyForPersistError)
  })
})
