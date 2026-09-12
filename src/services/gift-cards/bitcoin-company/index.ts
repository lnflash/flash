import { GiftCardError, GiftCardVendorUnavailableError } from "@domain/gift-cards"
import { baseLogger } from "@services/logger"
import {
  addAttributesToCurrentSpan,
  wrapAsyncFunctionsToRunInSpan,
} from "@services/tracing"

import { getRegisteredGiftCardProvider, registerGiftCardProvider } from "../registry"

import { BitcoinCompanyClient, BitcoinCompanyClientDeps } from "./client"
import {
  BITCOIN_COMPANY_PROVIDER_ID,
  ProductMappingSkipReason,
  isProductMappingSkip,
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

export const BitcoinCompanyProvider = (
  deps: BitcoinCompanyProviderDeps = {},
): IGiftCardProvider => {
  const client = deps.client ?? new BitcoinCompanyClient(deps.clientDeps)
  const now = deps.now ?? (() => new Date())

  const listProducts = async (): Promise<GiftCardProduct[] | GiftCardError> => {
    addAttributesToCurrentSpan(spanAttributes("listProducts"))
    const rows = await client.listProducts()
    if (rows instanceof Error) return rows

    const products: GiftCardProduct[] = []
    const skipped: Partial<Record<ProductMappingSkipReason, number>> = {}
    for (const row of rows) {
      const mapped = mapVendorProduct(row)
      if (isProductMappingSkip(mapped)) {
        skipped[mapped.skipped] = (skipped[mapped.skipped] ?? 0) + 1
        continue
      }
      products.push(mapped)
    }

    baseLogger.info(
      {
        provider: BITCOIN_COMPANY_PROVIDER_ID,
        op: "listProducts",
        received: rows.length,
        mapped: products.length,
        skipped,
      },
      "Bitcoin Company catalog mapped",
    )
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
  ): Promise<GiftCardProviderOrderStatus | GiftCardError> => {
    addAttributesToCurrentSpan(spanAttributes("getOrder"))
    // The vendor keys order status by invoice, not by order id.
    if (!ref.paymentRequest) {
      return new GiftCardVendorUnavailableError("status lookup requires payment request")
    }
    const vendor = await client.invoiceStatus(ref.paymentRequest)
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
