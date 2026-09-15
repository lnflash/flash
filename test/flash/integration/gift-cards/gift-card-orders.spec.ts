/**
 * The gift card orders repository is index- and race-shaped, and a mocked
 * model cannot report on either: the unit specs assert the query `transition`
 * issues and the options the schema declares, but nothing there executes
 * against a database. These run against the real collection so they can
 * return "no" about the claims the code makes:
 *
 *  - a conditional findOneAndUpdate on `status` means exactly one of two
 *    racing transitions from the same state wins; the other gets
 *    `GiftCardOrderStateError`, not a silent overwrite
 *    (`src/services/mongoose/gift-card-orders.ts`).
 *  - `{ walletId, idempotencyKey }` is unique, and the repository turns that
 *    E11000 into `GiftCardOrderDuplicateKeyError`.
 *  - `{ providerId, providerOrderId }` is a PARTIAL unique index: two orders
 *    still awaiting a vendor id (`providerOrderId: null`) must both insert. A
 *    sparse index would fail this (`schema.ts`, migration
 *    20260909120000-gift-card-orders-indexes).
 *  - `toJSON` drops `claimCiphertext`.
 *
 * Lives under test/flash/integration/gift-cards because the integration jest
 * config ignores test/flash/integration/services/*.
 *
 * Run: TEST=test/flash/integration/gift-cards yarn test:integration
 */
import { randomUUID } from "crypto"

import { DuplicateKeyForPersistError } from "@domain/errors"
import {
  GiftCardOrderNotFoundError,
  GiftCardOrderStateError,
  GiftCardOrderStatus,
  toGiftCardProviderOrderId,
} from "@domain/gift-cards"
import {
  GiftCardOrderDuplicateKeyError,
  GiftCardOrdersRepository,
  NewGiftCardOrderArgs,
} from "@services/mongoose"
import { GiftCardOrders } from "@services/mongoose/schema"

const repo = GiftCardOrdersRepository()

const newArgs = (
  overrides: Partial<NewGiftCardOrderArgs> = {},
): NewGiftCardOrderArgs => ({
  accountId: randomUUID() as AccountId,
  walletId: randomUUID() as WalletId,
  walletCurrency: "USD" as WalletCurrency,
  providerId: "bitcoinCompany",
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
  idempotencyKey: randomUUID(),
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  ...overrides,
})

const unwrap = <T>(value: T): Exclude<T, Error> => {
  if (value instanceof Error) throw value
  return value as Exclude<T, Error>
}

describe("GiftCardOrdersRepository (mongo)", () => {
  beforeAll(async () => {
    // The integration setup boots with syncIndexes(); make the requirement
    // explicit so a future setup change cannot silently turn these into
    // tests of an index-less collection.
    await GiftCardOrders.syncIndexes()
  })

  it("creates in CREATED and is found again by idempotency key", async () => {
    const args = newArgs()

    const created = unwrap(await repo.create(args))
    expect(created.status).toBe(GiftCardOrderStatus.Created)
    expect(created.statusHistory).toHaveLength(1)
    expect(created.statusHistory[0].status).toBe(GiftCardOrderStatus.Created)
    expect(created.providerOrderId).toBeNull()
    expect(created.claimCiphertext).toBeNull()

    const found = unwrap(
      await repo.findByIdempotencyKey({
        walletId: args.walletId,
        idempotencyKey: args.idempotencyKey,
      }),
    )
    expect(found.id).toBe(created.id)

    const byId = unwrap(await repo.findById(created.id))
    expect(byId.id).toBe(created.id)

    // Same key on a different wallet is a different order.
    expect(
      await repo.findByIdempotencyKey({
        walletId: randomUUID() as WalletId,
        idempotencyKey: args.idempotencyKey,
      }),
    ).toBeInstanceOf(GiftCardOrderNotFoundError)
  })

  it("rejects a second create with the same wallet + idempotency key", async () => {
    const args = newArgs()
    unwrap(await repo.create(args))

    const second = await repo.create(args)

    expect(second).toBeInstanceOf(GiftCardOrderDuplicateKeyError)
  })

  it("lets exactly one of two racing transitions from CREATED win", async () => {
    const created = unwrap(await repo.create(newArgs()))
    const providerOrderId = toGiftCardProviderOrderId(`tbc_${randomUUID()}`)

    const [a, b] = await Promise.all([
      repo.transition({
        id: created.id,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.InvoiceIssued,
        reason: "worker a",
        patch: {
          providerOrderId,
          paymentRequest: "lnbc-a",
          invoiceSats: 41300 as Satoshis,
        },
      }),
      repo.transition({
        id: created.id,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.InvoiceIssued,
        reason: "worker b",
        patch: { paymentRequest: "lnbc-b", invoiceSats: 41301 as Satoshis },
      }),
    ])

    const winners = [a, b].filter((r) => !(r instanceof Error))
    const losers = [a, b].filter((r) => r instanceof Error)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toBeInstanceOf(GiftCardOrderStateError)
    expect((losers[0] as Error).message).toBe(
      "cannot move INVOICE_ISSUED → INVOICE_ISSUED",
    )

    // The document holds exactly one INVOICE_ISSUED history entry — the loser
    // did not get to $push.
    const after = unwrap(await repo.findById(created.id))
    expect(after.status).toBe(GiftCardOrderStatus.InvoiceIssued)
    expect(
      after.statusHistory.filter((h) => h.status === GiftCardOrderStatus.InvoiceIssued),
    ).toHaveLength(1)
    expect(after.statusHistory).toHaveLength(2)
    expect(after.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it("reports a non-existent order as not found on transition", async () => {
    const result = await repo.transition({
      id: randomUUID() as GiftCardOrderId,
      from: [GiftCardOrderStatus.Created],
      to: GiftCardOrderStatus.Failed,
    })

    expect(result).toBeInstanceOf(GiftCardOrderNotFoundError)
  })

  it("accepts several orders per provider with no vendor id, but one per vendor id", async () => {
    // Two orders with providerOrderId: null for the same provider — a sparse
    // compound index would have rejected the second one.
    const first = unwrap(await repo.create(newArgs()))
    const second = unwrap(await repo.create(newArgs()))
    expect(first.providerOrderId).toBeNull()
    expect(second.providerOrderId).toBeNull()

    const providerOrderId = toGiftCardProviderOrderId(`tbc_${randomUUID()}`)
    unwrap(
      await repo.transition({
        id: first.id,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.InvoiceIssued,
        patch: { providerOrderId },
      }),
    )

    const found = unwrap(
      await repo.findByProviderOrderId({ providerId: "bitcoinCompany", providerOrderId }),
    )
    expect(found.id).toBe(first.id)

    // Same vendor id on a second order is a real bug: generic duplicate, not
    // the idempotency error.
    const collision = await repo.transition({
      id: second.id,
      from: [GiftCardOrderStatus.Created],
      to: GiftCardOrderStatus.InvoiceIssued,
      patch: { providerOrderId },
    })
    expect(collision).toBeInstanceOf(DuplicateKeyForPersistError)
    expect(collision).not.toBeInstanceOf(GiftCardOrderDuplicateKeyError)
  })

  it("lists an account newest first and pages by createdAt", async () => {
    const accountId = randomUUID() as AccountId
    const a = unwrap(await repo.create(newArgs({ accountId })))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = unwrap(await repo.create(newArgs({ accountId })))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const c = unwrap(await repo.create(newArgs({ accountId })))

    const page1 = unwrap(await repo.listByAccount({ accountId, limit: 2 }))
    expect(page1.map((o) => o.id)).toEqual([c.id, b.id])

    const page2 = unwrap(
      await repo.listByAccount({ accountId, limit: 2, before: page1[1].createdAt }),
    )
    expect(page2.map((o) => o.id)).toEqual([a.id])
  })

  it("lists by status oldest updatedAt first, bounded by updatedBefore", async () => {
    const created = unwrap(await repo.create(newArgs()))
    const issued = unwrap(
      await repo.transition({
        id: created.id,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.InvoiceIssued,
      }),
    )

    const stale = unwrap(
      await repo.listByStatus({
        statuses: [GiftCardOrderStatus.InvoiceIssued],
        updatedBefore: new Date(issued.updatedAt.getTime() + 1),
        limit: 1000,
      }),
    )
    expect(stale.map((o) => o.id)).toContain(issued.id)
    for (let i = 1; i < stale.length; i++) {
      expect(stale[i].updatedAt.getTime()).toBeGreaterThanOrEqual(
        stale[i - 1].updatedAt.getTime(),
      )
    }

    const none = unwrap(
      await repo.listByStatus({
        statuses: [GiftCardOrderStatus.InvoiceIssued],
        updatedBefore: new Date(0),
        limit: 10,
      }),
    )
    expect(none).toEqual([])
  })

  it("serialises without claimCiphertext", async () => {
    const created = unwrap(await repo.create(newArgs()))
    unwrap(
      await repo.transition({
        id: created.id,
        from: [GiftCardOrderStatus.Created],
        to: GiftCardOrderStatus.InvoiceIssued,
      }),
    )
    unwrap(
      await repo.transition({
        id: created.id,
        from: [GiftCardOrderStatus.InvoiceIssued],
        to: GiftCardOrderStatus.Paid,
      }),
    )
    const fulfilled = unwrap(
      await repo.transition({
        id: created.id,
        from: [GiftCardOrderStatus.Paid],
        to: GiftCardOrderStatus.Fulfilled,
        patch: {
          claimCiphertext: "SEALED-CLAIM",
          claimKeyId: "0123456789abcdef",
          fulfilledAt: new Date(),
        },
      }),
    )
    // The repository hands the ciphertext to the app layer for decryption...
    expect(fulfilled.claimCiphertext).toBe("SEALED-CLAIM")

    // ...but the document cannot serialise it.
    const doc = await GiftCardOrders.findOne({ id: created.id })
    expect(doc).not.toBeNull()
    expect(JSON.stringify(doc)).not.toContain("SEALED-CLAIM")
    expect(doc?.toJSON()).not.toHaveProperty("claimCiphertext")
    expect(doc?.toJSON().claimKeyId).toBe("0123456789abcdef")
  })
})
