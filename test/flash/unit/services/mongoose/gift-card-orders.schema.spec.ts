/**
 * Schema-level guarantees that a mocked model cannot report on: the five
 * indexes the migration creates are declared identically here (so
 * `syncIndexes()` on boot neither drops nor rebuilds them), the provider-order
 * index is partial rather than sparse, and `toJSON` drops the sealed claim.
 */
import { GiftCardOrders } from "@services/mongoose/schema"

type IndexEntry = [Record<string, unknown>, Record<string, unknown>]

const indexFor = (keys: string): IndexEntry | undefined =>
  (GiftCardOrders.schema.indexes() as IndexEntry[]).find(
    ([fields]) => Object.keys(fields).join(",") === keys,
  )

describe("GiftCardOrderSchema indexes", () => {
  it("declares exactly the five indexes the migration creates", () => {
    const declared = (GiftCardOrders.schema.indexes() as IndexEntry[]).map(([fields]) =>
      Object.entries(fields)
        .map(([k, v]) => `${k}:${v}`)
        .join(","),
    )
    expect(declared.sort()).toEqual(
      [
        "id:1",
        "accountId:1,createdAt:-1",
        "providerId:1,providerOrderId:1",
        "status:1,updatedAt:1",
        "walletId:1,idempotencyKey:1",
      ].sort(),
    )
  })

  it("id is unique", () => {
    const idx = indexFor("id")
    expect(idx).toBeDefined()
    expect(idx?.[1].unique).toBe(true)
  })

  it("walletId + idempotencyKey is unique, so a client retry cannot double-order", () => {
    const idx = indexFor("walletId,idempotencyKey")
    expect(idx).toBeDefined()
    expect(idx?.[1].unique).toBe(true)
  })

  it("providerId + providerOrderId is unique and partial, not sparse", () => {
    // A sparse compound index still indexes a document when ANY key is present,
    // and providerId always is — so two orders still awaiting a vendor id
    // (providerOrderId: null) would collide.
    const idx = indexFor("providerId,providerOrderId")
    expect(idx).toBeDefined()
    expect(idx?.[1].unique).toBe(true)
    expect(idx?.[1].partialFilterExpression).toEqual({
      providerOrderId: { $type: "string" },
    })
    expect(idx?.[1].sparse).toBeUndefined()
  })

  it("declares the two read-path indexes without uniqueness", () => {
    expect(indexFor("accountId,createdAt")?.[1].unique).toBeUndefined()
    expect(indexFor("status,updatedAt")?.[1].unique).toBeUndefined()
  })
})

describe("GiftCardOrderSchema toJSON", () => {
  it("drops claimCiphertext so an accidental serialisation cannot leak it", () => {
    const doc = new GiftCardOrders({
      id: "1f9d2c4e-8b7a-4c3d-9e2f-0a1b2c3d4e5f",
      accountId: "acc",
      walletId: "wal",
      walletCurrency: "USD",
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
      quoteSats: 41234,
      idempotencyKey: "idem-0001",
      status: "FULFILLED",
      statusHistory: [{ status: "FULFILLED", at: new Date(), reason: null }],
      claimCiphertext: "SEALED",
      claimKeyId: "0123456789abcdef",
      expiresAt: new Date(),
    })

    // The document itself still carries the value for the repository mapper.
    expect(doc.claimCiphertext).toBe("SEALED")

    const json = doc.toJSON() as Record<string, unknown>
    expect(json).not.toHaveProperty("claimCiphertext")
    expect(JSON.stringify(doc)).not.toContain("SEALED")
    // Only the ciphertext is hidden; the key id is needed for rotation bookkeeping.
    expect(json.claimKeyId).toBe("0123456789abcdef")
  })

  it("rejects a status outside the domain enum", () => {
    const doc = new GiftCardOrders({
      id: "x",
      accountId: "acc",
      walletId: "wal",
      walletCurrency: "USD",
      providerId: "bitcoinCompany",
      providerProductId: "p",
      productSnapshot: {
        name: "n",
        brand: "b",
        countryCode: "US",
        currency: "USD",
        isOpenLoop: false,
      },
      valueMinor: 1,
      currency: "USD",
      quantity: 1,
      quoteSats: 1,
      idempotencyKey: "k",
      status: "BOGUS",
      statusHistory: [],
      expiresAt: new Date(),
    })

    const err = doc.validateSync()
    expect(err?.errors.status).toBeDefined()
  })
})
