import {
  GiftCardError,
  GiftCardInvalidValueError,
  GiftCardVendorUnavailableError,
} from "@domain/gift-cards"
import { baseLogger } from "@services/logger"
import {
  addAttributesToCurrentSpan,
  wrapAsyncFunctionsToRunInSpan,
} from "@services/tracing"

import { getRegisteredGiftCardProvider, registerGiftCardProvider } from "../registry"

import { BitcoinCompanyClient, BitcoinCompanyClientDeps } from "./client"
import {
  BITCOIN_COMPANY_MAX_QUANTITY,
  BITCOIN_COMPANY_PROVIDER_ID,
  PRODUCT_MAPPING_SKIP_REASONS,
  ProductMappingSkipReason,
  isProductMappingSkip,
  isResellingDisabled,
  mapVendorOrderStatus,
  mapVendorProduct,
  mapVendorPurchase,
  mapVendorQuote,
  toMajorUnits,
} from "./mapping"

export * from "./client"
export * from "./errors"
export * from "./mapping"
export * from "./schemas"

/**
 * The Bitcoin Company `IGiftCardProvider`. Pure vendor I/O: money conversion,
 * status translation, and error mapping live here and in `mapping.ts`; Flash
 * policy (fees, limits, open-loop gating) belongs to the app layer.
 */

export type BitcoinCompanyProviderDeps = {
  client?: BitcoinCompanyClient
  /** Used only when `client` is not supplied. */
  clientDeps?: BitcoinCompanyClientDeps
  now?: () => Date
}

const spanAttributes = (op: string) => ({
  "giftcard.provider": BITCOIN_COMPANY_PROVIDER_ID,
  "giftcard.op": op,
})

const emptySkipCounts = (): Record<ProductMappingSkipReason, number> =>
  Object.fromEntries(PRODUCT_MAPPING_SKIP_REASONS.map((reason) => [reason, 0])) as Record<
    ProductMappingSkipReason,
    number
  >

/**
 * Every product this adapter lists carries `maxQuantity: 1`, so the app layer
 * rejects a larger order before reaching here. This is the belt to that brace:
 * a caller that bypasses the product check still never sends the vendor a
 * quantity whose status response we cannot read back.
 */
const checkQuantity = (quantity: number): GiftCardInvalidValueError | null =>
  quantity > BITCOIN_COMPANY_MAX_QUANTITY
    ? new GiftCardInvalidValueError(
        "Only one card per order is supported for this provider",
      )
    : null

export const BitcoinCompanyProvider = (
  deps: BitcoinCompanyProviderDeps = {},
): IGiftCardProvider => {
  const client = deps.client ?? new BitcoinCompanyClient(deps.clientDeps)
  const now = deps.now ?? (() => new Date())

  const listProducts = async (): Promise<GiftCardProduct[] | GiftCardError> => {
    addAttributesToCurrentSpan(spanAttributes("listProducts"))
    const catalog = await client.listProducts()
    if (catalog instanceof Error) return catalog

    const products: GiftCardProduct[] = []
    const skipped = emptySkipCounts()
    skipped.invalid = catalog.invalid
    let notResellable = 0
    for (const row of catalog.products) {
      const mapped = mapVendorProduct(row)
      if (isProductMappingSkip(mapped)) {
        skipped[mapped.skipped] += 1
        continue
      }
      if (isResellingDisabled(row)) notResellable += 1
      products.push(mapped)
    }

    const received = catalog.products.length + catalog.invalid
    const summary = {
      provider: BITCOIN_COMPANY_PROVIDER_ID,
      op: "listProducts",
      received,
      kept: products.length,
      skipped,
      flagged: { notResellable },
    }

    // Rows came back but none survived mapping: that is a vendor-side shape or
    // policy change, not a catalog. Returning [] would let the sync blank the
    // read model; failing keeps the last good catalog serving.
    if (received > 0 && products.length === 0) {
      baseLogger.error(
        summary,
        "Bitcoin Company catalog received rows but kept none; failing the sync",
      )
      return new GiftCardVendorUnavailableError(
        "Bitcoin Company catalog produced no usable products",
      )
    }

    if (notResellable > 0) {
      // TODO(ENG-586): flip to skip once KYB flips resellingEnabled.
      baseLogger.warn(
        { provider: BITCOIN_COMPANY_PROVIDER_ID, op: "listProducts", notResellable },
        "Bitcoin Company catalog rows have resellingEnabled=false; kept pending KYB",
      )
    }

    baseLogger.info(summary, "Bitcoin Company catalog mapped")
    return products
  }

  const quote = async ({
    product,
    valueMinor,
    quantity,
  }: {
    product: GiftCardProduct
    valueMinor: number
    quantity: number
  }): Promise<GiftCardQuote | GiftCardError> => {
    addAttributesToCurrentSpan(spanAttributes("quote"))
    const tooMany = checkQuantity(quantity)
    if (tooMany) return tooMany
    const vendor = await client.quoteCard({
      productId: product.providerProductId,
      cardValue: toMajorUnits(valueMinor),
      quantity,
    })
    if (vendor instanceof Error) return vendor
    return mapVendorQuote({ product, valueMinor, quantity, vendor, now: now() })
  }

  const createOrder = async ({
    product,
    valueMinor,
    quantity,
    reference,
  }: {
    product: GiftCardProduct
    valueMinor: number
    quantity: number
    reference: GiftCardOrderId
  }): Promise<GiftCardProviderOrder | GiftCardError> => {
    addAttributesToCurrentSpan(spanAttributes("createOrder"))
    const tooMany = checkQuantity(quantity)
    if (tooMany) return tooMany
    const vendor = await client.purchase({
      productId: product.providerProductId,
      cardValue: toMajorUnits(valueMinor),
      quantity,
      label: reference,
    })
    if (vendor instanceof Error) return vendor
    return mapVendorPurchase(vendor)
  }

  const getOrder = async (
    ref: GiftCardProviderOrderRef,
    opts: { retry?: boolean } = {},
  ): Promise<GiftCardProviderOrderStatus | GiftCardError> => {
    addAttributesToCurrentSpan(spanAttributes("getOrder"))
    // The vendor keys order status by invoice, not by order id.
    if (!ref.paymentRequest) {
      return new GiftCardVendorUnavailableError("status lookup requires payment request")
    }
    const vendor = await client.invoiceStatus(ref.paymentRequest, {
      retry: opts.retry ?? true,
    })
    if (vendor instanceof Error) return vendor

    const { status, warning } = mapVendorOrderStatus(vendor)
    if (warning) {
      baseLogger.warn(
        {
          provider: BITCOIN_COMPANY_PROVIDER_ID,
          op: "getOrder",
          providerOrderId: ref.providerOrderId,
          vendorStatus: vendor.status,
        },
        warning,
      )
    }
    return status
  }

  return {
    id: BITCOIN_COMPANY_PROVIDER_ID,
    ...wrapAsyncFunctionsToRunInSpan({
      namespace: "services.gift-cards.bitcoin-company",
      fns: { listProducts, quote, createOrder, getOrder },
    }),
  }
}

/**
 * Idempotent: registers the provider only if the registry does not already
 * hold one under this id, so re-imports and repeated calls never double up.
 */
export const registerBitcoinCompanyProvider = (): void => {
  if (getRegisteredGiftCardProvider(BITCOIN_COMPANY_PROVIDER_ID)) return
  registerGiftCardProvider(BitcoinCompanyProvider())
}

registerBitcoinCompanyProvider()
