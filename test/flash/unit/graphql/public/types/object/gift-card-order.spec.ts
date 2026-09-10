import { GiftCardOrderStatus } from "@domain/gift-cards"
import GiftCardOrder, {
  GiftCardOrderConnection,
  GiftCardOrderStatusEnum,
  toGiftCardOrderSource,
} from "@graphql/public/types/object/gift-card-order"
import GiftCardProduct, {
  GiftCardDenominationTypeEnum,
  GiftCardProductConnection,
} from "@graphql/public/types/object/gift-card-product"

import { makeOrder } from "test/flash/unit/app/gift-cards/fixtures"

const CLAIM: GiftCardClaim = {
  codes: [{ label: "PIN", value: "1234" }],
  claimLink: null,
  barcode: null,
}

describe("GiftCardOrderStatus enum", () => {
  it("serializes every domain status to a member of the same name", () => {
    // The domain constants ARE the wire spelling, so each must round-trip to
    // itself. A status added to the domain without a member here fails this
    // at the `serialize` call rather than at the customer polling their order.
    const statuses = Object.values(GiftCardOrderStatus)
    expect(statuses).toHaveLength(9)

    for (const status of statuses) {
      expect(GiftCardOrderStatusEnum.serialize(status)).toBe(status)
    }
  })

  it("has exactly the members the design doc lists, and no others", () => {
    expect(
      GiftCardOrderStatusEnum.getValues()
        .map((v) => v.name)
        .sort(),
    ).toEqual(
      [
        "CREATED",
        "INVOICE_ISSUED",
        "PAYMENT_PENDING",
        "PAID",
        "FULFILLED",
        "FAILED",
        "PAYMENT_FAILED",
        "EXPIRED",
        "REFUND_REQUIRED",
      ].sort(),
    )
  })

  it("refuses a value no member carries", () => {
    // The assertions above are only worth something if serialize can say no.
    expect(() => GiftCardOrderStatusEnum.serialize("fulfilled")).toThrow()
    expect(() => GiftCardOrderStatusEnum.serialize("DELIVERED")).toThrow()
  })

  it("describes every member", () => {
    for (const value of GiftCardOrderStatusEnum.getValues()) {
      expect(value.description).toBeTruthy()
    }
  })
})

describe("GiftCardDenominationType enum", () => {
  it("serializes the domain's lower-case values to upper-case members", () => {
    expect(GiftCardDenominationTypeEnum.serialize("fixed")).toBe("FIXED")
    expect(GiftCardDenominationTypeEnum.serialize("variable")).toBe("VARIABLE")
  })

  it("refuses the wire spelling as an internal value", () => {
    expect(() => GiftCardDenominationTypeEnum.serialize("FIXED")).toThrow()
  })
})

describe("toGiftCardOrderSource", () => {
  it("exposes exactly the public fields, and nothing the domain row carries beyond them", () => {
    const source = toGiftCardOrderSource(
      makeOrder({ claimCiphertext: "enc:secret", claimKeyId: "k1" }),
    )

    expect(Object.keys(source).sort()).toEqual(
      [
        "id",
        "status",
        "product",
        "value",
        "currency",
        "quantity",
        "paidSats",
        "claim",
        "createdAt",
        "fulfilledAt",
        "failureReason",
      ].sort(),
    )
    expect(source).not.toHaveProperty("claimCiphertext")
    expect(source).not.toHaveProperty("claimKeyId")
    expect(source).not.toHaveProperty("paymentRequest")
    expect(source).not.toHaveProperty("idempotencyKey")
    expect(source).not.toHaveProperty("walletId")
    expect(JSON.stringify(source)).not.toContain("enc:secret")
  })

  it("attaches the claim only for a FULFILLED order", () => {
    expect(
      toGiftCardOrderSource(makeOrder({ status: "FULFILLED" }), CLAIM).claim,
    ).toEqual(CLAIM)

    for (const status of Object.values(GiftCardOrderStatus)) {
      if (status === GiftCardOrderStatus.Fulfilled) continue
      expect(toGiftCardOrderSource(makeOrder({ status }), CLAIM).claim).toBeNull()
    }
  })

  it("defaults the claim to null", () => {
    expect(toGiftCardOrderSource(makeOrder({ status: "FULFILLED" })).claim).toBeNull()
  })

  it("renames the money field and hands Dates through for the Timestamp scalar", () => {
    const createdAt = new Date("2026-09-09T09:00:00Z")
    const fulfilledAt = new Date("2026-09-09T09:01:00Z")
    const source = toGiftCardOrderSource(
      makeOrder({
        status: "FULFILLED",
        valueMinor: 7_500,
        paidSats: 123_456 as Satoshis,
        createdAt,
        fulfilledAt,
      }),
    )

    expect(source.value).toBe(7_500)
    expect(source.paidSats).toBe(123_456)
    expect(source.createdAt).toBe(createdAt)
    expect(source.fulfilledAt).toBe(fulfilledAt)
  })
})

describe("GraphQL type shapes", () => {
  it("GiftCardOrder declares no field that could carry encrypted claim material", () => {
    const fields = Object.keys(GiftCardOrder.getFields())

    expect(fields).not.toContain("claimCiphertext")
    expect(fields).not.toContain("claimKeyId")
    expect(fields).not.toContain("paymentRequest")
    expect(fields).toEqual(
      expect.arrayContaining([
        "id",
        "status",
        "product",
        "value",
        "currency",
        "quantity",
        "paidSats",
        "claim",
        "createdAt",
        "fulfilledAt",
        "failureReason",
      ]),
    )
  })

  it("GiftCardProduct declares the storefront fields and hides the vendor plumbing", () => {
    const fields = Object.keys(GiftCardProduct.getFields())

    expect(fields).not.toContain("providerId")
    expect(fields).not.toContain("providerProductId")
    expect(fields).not.toContain("inStock")
    expect(fields.sort()).toEqual(
      [
        "id",
        "name",
        "brand",
        "countryCode",
        "currency",
        "denominationType",
        "denominations",
        "minValue",
        "maxValue",
        "isOpenLoop",
        "categories",
        "logoUrl",
        "termsUrl",
        "rewardBps",
      ].sort(),
    )
  })

  it("describes every field on the public types", () => {
    for (const type of [GiftCardOrder, GiftCardProduct]) {
      for (const [name, field] of Object.entries(type.getFields())) {
        expect({
          type: type.name,
          field: name,
          described: Boolean(field.description),
        }).toEqual({ type: type.name, field: name, described: true })
      }
    }
  })

  it("names the connections the way the design doc does", () => {
    expect(GiftCardOrderConnection.name).toBe("GiftCardOrderConnection")
    expect(GiftCardProductConnection.name).toBe("GiftCardProductConnection")
    expect(Object.keys(GiftCardOrderConnection.getFields()).sort()).toEqual([
      "edges",
      "pageInfo",
    ])
  })
})
