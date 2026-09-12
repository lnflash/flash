import {
  checkedGiftCardQuantity,
  checkedGiftCardValue,
  GiftCardProductNotAvailableInCountryError,
  GiftCardProductNotFoundError,
} from "@domain/gift-cards"
import { RateLimitConfig } from "@domain/rate-limit"
import { GiftCardQuoteRateLimiterExceededError } from "@domain/rate-limit/errors"
import { getEnabledGiftCardProvider } from "@services/gift-cards/registry"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import { consumeLimiter } from "@services/rate-limit"
import { addAttributesToCurrentSpan } from "@services/tracing"

import {
  giftCardsMasterGate,
  resolveAccountCountryCodeOrUnknown,
} from "./gift-cards-master-gate"
import { getGiftCardProduct } from "./list-products"

/**
 * ENG-582 — a price for the storefront, BEFORE any order exists.
 *
 *   attempt budget → gate → product → validate → provider.quote
 *
 * Deliberately the same first four steps as `purchaseGiftCard`, in the same
 * order with the same errors, so the quote can never say yes where the
 * purchase would then say no: a product from a provider the account's country
 * is not routed to, an out-of-stock row, an off-denomination value — every one
 * of those is refused here with the error the mutation would give.
 *
 * Nothing is written and no purchase limit is consumed: a quote is not a
 * reservation. The only thing charged is the per-account ATTEMPT budget
 * (`RateLimitConfig.giftCardQuote`), because every call past it is a live POST
 * to the vendor through the one shared reseller login that every purchase also
 * needs — a client looping on this field could get that login throttled or
 * locked and fail every customer's purchase.
 *
 * The number comes straight from the vendor and is good until `expiresAt`; the
 * purchase re-quotes and refuses to pay an invoice that drifted past tolerance
 * (`GIFT_CARD_QUOTE_TOLERANCE_BPS`), so a stale quote costs the customer a
 * retry, never money.
 */
export type QuoteGiftCardArgs = {
  accountId: AccountId
  productId: string
  valueMinor: number
  quantity: number
}

export const quoteGiftCard = async ({
  accountId,
  productId,
  valueMinor,
  quantity,
}: QuoteGiftCardArgs): Promise<GiftCardQuote | ApplicationError> => {
  addAttributesToCurrentSpan({
    "giftcard.productId": productId,
    "giftcard.valueMinor": valueMinor,
    "giftcard.quantity": quantity,
  })

  // Attempt budget, charged before any store or vendor round-trip so a client
  // looping on a refused request bounds its own cost. A limiter STORE fault
  // falls through (same posture as purchaseGiftCard): refusing every quote
  // during a Redis blip would page nobody and block everyone.
  const limitOk = await consumeLimiter({
    rateLimitConfig: RateLimitConfig.giftCardQuote,
    keyToConsume: accountId,
  })
  if (limitOk instanceof GiftCardQuoteRateLimiterExceededError) return limitOk
  if (limitOk instanceof Error) {
    baseLogger.warn(
      { accountId, error: limitOk.constructor.name },
      "Gift card quote rate limiter unavailable; continuing",
    )
  }

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  const countryCode = await resolveAccountCountryCodeOrUnknown(account)
  const gate = giftCardsMasterGate(countryCode)
  if (!gate.ok) return gate.error
  addAttributesToCurrentSpan({ "giftcard.provider": gate.providerId })

  const product = await getGiftCardProduct(productId as GiftCardProductId)
  if (product instanceof Error) return product
  if (product.providerId !== gate.providerId) {
    return new GiftCardProductNotAvailableInCountryError()
  }
  if (!product.inStock) {
    return new GiftCardProductNotFoundError("This gift card is currently out of stock")
  }

  const checkedValue = checkedGiftCardValue(product, valueMinor)
  if (checkedValue instanceof Error) return checkedValue
  const checkedQuantity = checkedGiftCardQuantity(quantity)
  if (checkedQuantity instanceof Error) return checkedQuantity

  const provider = getEnabledGiftCardProvider(gate.providerId)
  if (provider instanceof Error) return provider

  return provider.quote({
    product,
    valueMinor: checkedValue,
    quantity: checkedQuantity,
  })
}
