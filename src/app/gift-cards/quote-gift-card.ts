import {
  checkedGiftCardQuantity,
  checkedGiftCardValue,
  GiftCardProductNotAvailableInCountryError,
  GiftCardProductNotFoundError,
} from "@domain/gift-cards"
import { getEnabledGiftCardProvider } from "@services/gift-cards/registry"
import { AccountsRepository } from "@services/mongoose"
import { addAttributesToCurrentSpan } from "@services/tracing"

import {
  giftCardsMasterGate,
  resolveAccountCountryCodeOrUnknown,
} from "./gift-cards-master-gate"
import { getGiftCardProduct } from "./list-products"

/**
 * ENG-582 — a price for the storefront, BEFORE any order exists.
 *
 *   gate → product → validate → provider.quote
 *
 * Deliberately the same first four steps as `purchaseGiftCard`, in the same
 * order with the same errors, so the quote can never say yes where the
 * purchase would then say no: a product from a provider the account's country
 * is not routed to, an out-of-stock row, an off-denomination value — every one
 * of those is refused here with the error the mutation would give.
 *
 * Nothing is written and no limit is consumed: a quote is not a reservation.
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
