import {
  BITCOIN_COMPANY_MAX_QUANTITY,
  KNOWN_VENDOR_STATUSES,
  PRODUCT_MAPPING_SKIP_REASONS,
  QUOTE_TTL_MS,
  isProductMappingSkip,
  isResellingDisabled,
  mapDenominationType,
  mapVendorClaim,
  mapVendorOrderStatus,
  mapVendorProduct,
  mapVendorPurchase,
  mapVendorQuote,
  stripBrand,
  toMajorUnits,
  toMinorUnits,
} from "@services/gift-cards/bitcoin-company/mapping"
import { vendorProductSchema } from "@services/gift-cards/bitcoin-company/schemas"

import {
  CLAIM_CODE,
  CLAIM_LINK,
  NOW,
  PURCHASE_RESULT,
  QUOTE_RESULT,
  VendorProductJson,
  vendorProductFixture,
  vendorVariableProductFixture,
} from "./fixtures"

const now = new Date(NOW)

/** Run the fixture through the real schema so the mapper sees what the client hands it. */
const parsed = (json: VendorProductJson) => vendorProductSchema.parse(json)

const mapped = (json: VendorProductJson): GiftCardProduct => {
  const result = mapVendorProduct(parsed(json))
  if (isProductMappingSkip(result)) throw new Error(`unexpected skip: ${result.skipped}`)
  return result
}

const skipReason = (json: VendorProductJson): string | null => {
  const result = mapVendorProduct(parsed(json))
  return isProductMappingSkip(result) ? result.skipped : null
}

describe("unit conversion", () => {
  it.each([
    [25, 2500],
    [12.34, 1234],
    [0.1, 10],
    [64102.56, 6410256],
    [0, 0],
  ])("toMinorUnits(%p) = %p", (major, minor) => {
    expect(toMinorUnits(major)).toBe(minor)
  })

  it("toMajorUnits inverts toMinorUnits", () => {
    expect(toMajorUnits(2500)).toBe(25)
    expect(toMajorUnits(1234)).toBe(12.34)
  })
})

describe("mapVendorProduct", () => {
  it("maps a fixed-denomination product to minor units", () => {
    expect(mapped(vendorProductFixture())).toEqual({
      id: "bitcoinCompany:prod-amazon-us",
      providerId: "bitcoinCompany",
      providerProductId: "prod-amazon-us",
      name: "Amazon 🇺🇸 (US)",
      brand: "Amazon",
      countryCode: "US",
      currency: "USD",
      denominationType: "fixed",
      denominations: [1000, 2500, 5000],
      minValue: null,
      maxValue: null,
      isOpenLoop: false,
      categories: ["Shopping"],
      logoUrl: "https://cdn.example/amazon.png",
      termsUrl: null,
      rewardBps: 150,
      inStock: true,
      maxQuantity: 1,
      wholeUnitsOnly: false,
    })
  })

  it("caps every product at one card per order until a multi-card status fixture exists", () => {
    expect(BITCOIN_COMPANY_MAX_QUANTITY).toBe(1)
    expect(mapped(vendorProductFixture()).maxQuantity).toBe(1)
    expect(mapped(vendorVariableProductFixture()).maxQuantity).toBe(1)
  })

  it("maps a variable product to a min/max range with no fixed denominations", () => {
    expect(mapped(vendorVariableProductFixture())).toEqual(
      expect.objectContaining({
        id: "bitcoinCompany:prod-visa-us",
        brand: "Visa",
        denominationType: "variable",
        denominations: [],
        minValue: 500,
        maxValue: 50000,
        isOpenLoop: true,
        rewardBps: 50,
        wholeUnitsOnly: false,
      }),
    )
  })

  it("treats VariableNoCents as variable that only accepts whole units", () => {
    const product = mapped(
      vendorVariableProductFixture({ denominationType: "VariableNoCents" }),
    )
    expect(product.denominationType).toBe("variable")
    expect(product.minValue).toBe(500)
    expect(product.maxValue).toBe(50000)
    expect(product.wholeUnitsOnly).toBe(true)
  })

  it.each(["Fixed", "Variable"])(
    "%p products are not whole-units-only",
    (denominationType) => {
      expect(
        mapped(vendorVariableProductFixture({ denominationType })).wholeUnitsOnly,
      ).toBe(false)
    },
  )

  it("dedupes, sorts, and drops non-positive denominations", () => {
    const product = mapped(
      vendorProductFixture({ denominations: [50, 10, 10, 0, -5, 25] }),
    )
    expect(product.denominations).toEqual([1000, 2500, 5000])
  })

  it("derives the variable range from the extremes regardless of order", () => {
    const product = mapped(
      vendorVariableProductFixture({ denominations: [100, 5, 250, 20] }),
    )
    expect(product.minValue).toBe(500)
    expect(product.maxValue).toBe(25000)
  })

  it.each([
    ["no countries", vendorProductFixture({ countries: [] }), "noCountry"],
    ["blank countries", vendorProductFixture({ countries: ["", "  "] }), "noCountry"],
    ["a physical card", vendorProductFixture({ isPhysical: true }), "physical"],
    [
      "payment types that exclude Lightning",
      vendorProductFixture({ paymentTypes: ["OnChain", "Card"] }),
      "noLightning",
    ],
    [
      "an empty payment types list",
      vendorProductFixture({ paymentTypes: [] }),
      "noLightning",
    ],
    [
      "an unknown denomination type",
      vendorProductFixture({ denominationType: "Tiered" }),
      "unknownDenominationType",
    ],
    [
      "a fixed product with no denominations",
      vendorProductFixture({ denominations: [] }),
      "noDenominations",
    ],
    [
      "a variable product with no denominations",
      vendorVariableProductFixture({ denominations: [] }),
      "noDenominations",
    ],
    [
      "only non-positive denominations",
      vendorProductFixture({ denominations: [0, -1] }),
      "noDenominations",
    ],
  ])("skips a product with %s", (_label, json, reason) => {
    expect(skipReason(json)).toBe(reason)
    // Every reason the mapper can produce is one the adapter zero-initialises
    // in its sync log, so a new reason cannot silently go uncounted.
    expect(PRODUCT_MAPPING_SKIP_REASONS).toContain(reason)
  })

  it.each([
    ["isPhysical absent", vendorProductFixture({ isPhysical: undefined })],
    ["isPhysical null", vendorProductFixture({ isPhysical: null as unknown as boolean })],
    ["isPhysical false", vendorProductFixture({ isPhysical: false })],
    [
      "paymentTypes absent (vendor did not say)",
      vendorProductFixture({ paymentTypes: undefined }),
    ],
    [
      "paymentTypes null",
      vendorProductFixture({ paymentTypes: null as unknown as string[] }),
    ],
    [
      "Lightning among other rails",
      vendorProductFixture({ paymentTypes: ["OnChain", "Lightning"] }),
    ],
    ["Lightning in another case", vendorProductFixture({ paymentTypes: ["lightning"] })],
  ])("keeps a product with %s", (_label, json) => {
    expect(skipReason(json)).toBeNull()
  })

  it("keeps resellingEnabled=false rows and exposes the flag for the adapter to count", () => {
    // Every product shows false until the account is KYB'd; skipping would
    // empty the catalog. TODO(ENG-586): flip to skip once KYB flips it.
    const notResellable = vendorProductFixture({ resellingEnabled: false })
    expect(skipReason(notResellable)).toBeNull()
    expect(isResellingDisabled(parsed(notResellable))).toBe(true)
    expect(
      isResellingDisabled(parsed(vendorProductFixture({ resellingEnabled: true }))),
    ).toBe(false)
    expect(
      isResellingDisabled(parsed(vendorProductFixture({ resellingEnabled: undefined }))),
    ).toBe(false)
  })

  it("uses the first non-blank country, normalised", () => {
    expect(
      mapped(vendorProductFixture({ countries: [" ", "gb", "US"] })).countryCode,
    ).toBe("GB")
  })

  it("normalises currency and trims the name", () => {
    const product = mapped(vendorProductFixture({ currency: " usd", name: "  Target  " }))
    expect(product.currency).toBe("USD")
    expect(product.name).toBe("Target")
    expect(product.brand).toBe("Target")
  })

  it.each([
    [1.5, 150],
    [0.5, 50],
    [1.25, 125],
    [0, 0],
    [10, 1000],
  ])("converts satsBackPercentage %p to %p bps", (pct, bps) => {
    expect(mapped(vendorProductFixture({ satsBackPercentage: pct })).rewardBps).toBe(bps)
  })

  it.each([
    [0, false],
    [-1, true],
    [7, true],
  ])("stock %p → inStock %p", (stock, inStock) => {
    expect(mapped(vendorProductFixture({ stock })).inStock).toBe(inStock)
  })

  it("prefers logo, falls back to panelImg, else null", () => {
    expect(
      mapped(vendorProductFixture({ logo: "a.png", panelImg: "b.png" })).logoUrl,
    ).toBe("a.png")
    expect(mapped(vendorProductFixture({ logo: null, panelImg: "b.png" })).logoUrl).toBe(
      "b.png",
    )
    expect(mapped(vendorProductFixture({ logo: "", panelImg: "b.png" })).logoUrl).toBe(
      "b.png",
    )
    expect(
      mapped(vendorProductFixture({ logo: null, panelImg: null })).logoUrl,
    ).toBeNull()
  })

  it("never maps vendor terms text to termsUrl", () => {
    expect(
      mapped(vendorProductFixture({ terms: "https://looks.like/a/url" })).termsUrl,
    ).toBeNull()
  })

  it("defaults missing categories to an empty list", () => {
    expect(mapped(vendorProductFixture({ categories: undefined })).categories).toEqual([])
  })
})

describe("stripBrand", () => {
  it.each([
    ["Visa 🇺🇸 (US)", "Visa"],
    ["Amazon (US)", "Amazon"],
    ["Amazon 🇺🇸", "Amazon"],
    ["Steam (USA) 🇺🇸", "Steam"],
    ["Tim Hortons 🇨🇦 (CA)", "Tim Hortons"],
    ["Xbox (Digital)", "Xbox (Digital)"],
    ["  Target  ", "Target"],
    ["Best Buy", "Best Buy"],
    ["🇺🇸", "🇺🇸"],
  ])("%p → %p", (input, expected) => {
    expect(stripBrand(input)).toBe(expected)
  })
})

describe("mapDenominationType", () => {
  it.each([
    ["Fixed", "fixed"],
    ["Variable", "variable"],
    ["VariableNoCents", "variable"],
    ["fixed", null],
    ["Other", null],
  ])("%p → %p", (raw, expected) => {
    expect(mapDenominationType(raw)).toBe(expected)
  })
})

describe("mapVendorQuote", () => {
  const product = mapped(vendorProductFixture())

  it("converts vendor major units and sats into the port quote", () => {
    const quote = mapVendorQuote({
      product,
      valueMinor: 2500,
      quantity: 1,
      vendor: QUOTE_RESULT,
      now,
    })

    expect(quote).toEqual({
      productId: "bitcoinCompany:prod-amazon-us",
      valueMinor: 2500,
      currency: "USD",
      quantity: 1,
      fiatCostMinor: 2500,
      satsCost: 39000,
      rewardSats: 585,
      bitcoinPriceMinor: 6410256,
      expiresAt: new Date(NOW + QUOTE_TTL_MS),
    })
    expect(QUOTE_TTL_MS).toBe(60_000)
  })

  it("rounds fractional sats", () => {
    const quote = mapVendorQuote({
      product,
      valueMinor: 2500,
      quantity: 2,
      vendor: { ...QUOTE_RESULT, satsCost: 39000.4, satsBack: 584.6 },
      now,
    })
    expect(quote.satsCost).toBe(39000)
    expect(quote.rewardSats).toBe(585)
    expect(quote.quantity).toBe(2)
  })

  it("reports a null bitcoinPrice as null rather than 0, and a 0 satsBack as no reward", () => {
    const quote = mapVendorQuote({
      product,
      valueMinor: 2500,
      quantity: 1,
      vendor: { fiatCost: 25, satsCost: 39000, satsBack: 0, bitcoinPrice: null },
      now,
    })
    expect(quote.bitcoinPriceMinor).toBeNull()
    expect(quote.rewardSats).toBe(0)
    expect(quote.satsCost).toBe(39000)
    expect(quote.fiatCostMinor).toBe(2500)
  })

  it("reports an absent bitcoinPrice as null", () => {
    const quote = mapVendorQuote({
      product,
      valueMinor: 2500,
      quantity: 1,
      vendor: { fiatCost: 25, satsCost: 39000, satsBack: 585 },
      now,
    })
    expect(quote.bitcoinPriceMinor).toBeNull()
  })
})

describe("mapVendorPurchase", () => {
  it("maps invoice, amount, and uuid into the provider order", () => {
    expect(mapVendorPurchase(PURCHASE_RESULT)).toEqual({
      providerOrderId: PURCHASE_RESULT.uuid,
      paymentRequest: PURCHASE_RESULT.invoice,
      amountSats: 39000,
      expiresAt: null,
    })
  })

  it("never fabricates an order expiry: the vendor reports none, the BOLT11 carries it", () => {
    expect(mapVendorPurchase(PURCHASE_RESULT).expiresAt).toBeNull()
  })

  it("stringifies a numeric uuid and rounds the amount", () => {
    const order = mapVendorPurchase({ ...PURCHASE_RESULT, uuid: 42, amount: 100.6 })
    expect(order.providerOrderId).toBe("42")
    expect(order.amountSats).toBe(101)
  })

  it("maps a missing or null amount to 0 sats: the decoded BOLT11 amount governs what is paid", () => {
    // `amountSats` is non-null on the port. 0 is safe because the purchase path
    // pays max(invoiceSats, amountSats): the vendor figure can only raise the
    // charge, never lower it below the invoice.
    expect(mapVendorPurchase({ ...PURCHASE_RESULT, amount: null }).amountSats).toBe(0)
    expect(mapVendorPurchase({ invoice: PURCHASE_RESULT.invoice, uuid: "u-1" })).toEqual({
      providerOrderId: "u-1",
      paymentRequest: PURCHASE_RESULT.invoice,
      amountSats: 0,
      expiresAt: null,
    })
  })

  it("does not need orderId: uuid is the key we store and query by", () => {
    const order = mapVendorPurchase({ ...PURCHASE_RESULT, orderId: null })
    expect(order.providerOrderId).toBe(PURCHASE_RESULT.uuid)
  })
})

describe("mapVendorClaim", () => {
  it("returns null when there is nothing to redeem", () => {
    expect(mapVendorClaim(null)).toBeNull()
    expect(mapVendorClaim(undefined)).toBeNull()
    expect(mapVendorClaim({})).toBeNull()
    expect(mapVendorClaim({ codes: [], claimLink: null })).toBeNull()
    expect(mapVendorClaim({ codes: [{ value: "   " }], claimLink: "" })).toBeNull()
  })

  it("keeps codes with values, a claim link, and a complete barcode", () => {
    expect(
      mapVendorClaim({
        codes: [{ label: "PIN", value: "1234" }, { value: "CODE" }, { value: "" }],
        claimLink: CLAIM_LINK,
        barcodeChars: "0123456789",
        barcodeType: "CODE128",
      }),
    ).toEqual({
      codes: [
        { label: "PIN", value: "1234" },
        { label: null, value: "CODE" },
      ],
      claimLink: CLAIM_LINK,
      barcode: { chars: "0123456789", type: "CODE128" },
    })
  })

  it("drops an incomplete barcode", () => {
    expect(mapVendorClaim({ claimLink: CLAIM_LINK, barcodeChars: "0123" })).toEqual({
      codes: [],
      claimLink: CLAIM_LINK,
      barcode: null,
    })
  })
})

describe("mapVendorOrderStatus", () => {
  const claimData = {
    codes: [{ label: "Code", value: CLAIM_CODE }],
    claimLink: CLAIM_LINK,
  }

  // Statuses the adapter settles without comment. Disputed is deliberately
  // absent: it is held, with a warning, and tested on its own below.
  const SETTLED: ReadonlyArray<[string, GiftCardProviderOrderStatus["kind"]]> = [
    ["Unpaid", "awaitingPayment"],
    ["Underpaid", "awaitingPayment"],
    ["Confirming", "awaitingPayment"],
    ["Pending", "paidPendingFulfillment"],
    ["SentToFulfillment", "paidPendingFulfillment"],
    ["Completed", "fulfilled"],
    ["Sent", "fulfilled"],
    ["Claimed", "fulfilled"],
    ["Shipped", "fulfilled"],
    ["Expired", "failed"],
    ["Cancelled", "failed"],
    ["Refunded", "refunded"],
    ["ClawedBack", "refunded"],
  ]
  const HELD = ["Disputed"]

  it.each(SETTLED)(
    "maps vendor status %p to %p without a warning",
    (vendorStatus, kind) => {
      const { status, warning } = mapVendorOrderStatus({
        status: vendorStatus,
        claimData,
      })
      expect(status.kind).toBe(kind)
      expect(warning).toBeNull()
    },
  )

  it("the settled + held rows above are exactly the statuses the adapter knows", () => {
    // Derived from the exported list, not a hard-coded count: adding a status
    // to the adapter without a row here fails this test by name.
    const covered = [...SETTLED.map(([s]) => s), ...HELD].map((s) => s.toLowerCase())
    expect(covered.sort()).toEqual([...KNOWN_VENDOR_STATUSES].sort())
  })

  it.each(HELD)(
    "holds %p as paidPendingFulfillment with a warning, even when claim data is present",
    (vendorStatus) => {
      // A dispute is not a refund: money may still come back as a card or as a
      // refund. A later Refunded / ClawedBack / Completed poll, or the 24h
      // timeout, decides; calling it terminal now would be a guess.
      const { status, warning } = mapVendorOrderStatus({
        status: vendorStatus,
        claimData,
      })
      expect(status).toEqual({ kind: "paidPendingFulfillment" })
      expect(warning).toContain(vendorStatus)
      expect(warning).toContain("holding as pending")
    },
  )

  it("carries the vendor status as the reason for failed and refunded", () => {
    expect(mapVendorOrderStatus({ status: "Expired" }).status).toEqual({
      kind: "failed",
      reason: "Expired",
    })
    expect(mapVendorOrderStatus({ status: "ClawedBack" }).status).toEqual({
      kind: "refunded",
      reason: "ClawedBack",
    })
  })

  it("returns the mapped claim for a fulfilled status", () => {
    expect(mapVendorOrderStatus({ status: "Completed", claimData }).status).toEqual({
      kind: "fulfilled",
      claim: {
        codes: [{ label: "Code", value: CLAIM_CODE }],
        claimLink: CLAIM_LINK,
        barcode: null,
      },
    })
  })

  it("is case-insensitive on the vendor status", () => {
    expect(mapVendorOrderStatus({ status: "completed", claimData }).status.kind).toBe(
      "fulfilled",
    )
    expect(mapVendorOrderStatus({ status: "UNPAID" }).status.kind).toBe("awaitingPayment")
    expect(mapVendorOrderStatus({ status: " Pending " }).status.kind).toBe(
      "paidPendingFulfillment",
    )
  })

  it.each(["Completed", "Sent", "Claimed", "Shipped"])(
    "holds %p as paidPendingFulfillment when there is nothing to redeem",
    (vendorStatus) => {
      for (const emptyClaim of [undefined, null, {}, { codes: [], claimLink: null }]) {
        const { status, warning } = mapVendorOrderStatus({
          status: vendorStatus,
          claimData: emptyClaim,
        })
        expect(status).toEqual({ kind: "paidPendingFulfillment" })
        expect(warning).toContain(vendorStatus)
      }
    },
  )

  it("holds an unknown status as paidPendingFulfillment with a warning, never fulfilled", () => {
    const { status, warning } = mapVendorOrderStatus({ status: "Teleported", claimData })
    expect(status).toEqual({ kind: "paidPendingFulfillment" })
    expect(warning).toContain("Teleported")
  })
})
