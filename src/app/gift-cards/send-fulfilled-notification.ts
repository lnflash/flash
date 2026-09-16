import { sendOutcomeNotificationBestEffort } from "@app/notifications/send-outcome-notification"

/**
 * "Your <brand> gift card is ready" — the push that closes the loop the
 * mutation deliberately does not wait for. `purchaseGiftCard` returns as soon
 * as the invoice is PAID; fulfilment usually lands seconds later via the first
 * poll or the reconcile worker, and this is how the customer learns it did.
 *
 * Carries NO claim data. The push payload travels through FCM and sits in the
 * OS notification store; the code is fetched over an authenticated GraphQL
 * read (`getGiftCardOrderForAccount`) and nowhere else. `orderId` is included
 * so the app can deep-link straight to it.
 *
 * Best-effort by construction (same contract as the Fygaro top-up push): the
 * order is already FULFILLED when this fires, and a notification failure must
 * never unwind that.
 */
export type GiftCardFulfilledNotificationArgs = {
  accountId: string
  orderId: string
  brand: string
  valueMinor: number
  quantity: number
  currency: string
}

const formatMajorUnits = (minor: number): string => (minor / 100).toFixed(2)

export const GIFT_CARD_FULFILLED_DATA_TYPE = "gift_card_fulfilled"

export const sendGiftCardFulfilledNotificationBestEffort = async ({
  accountId,
  orderId,
  brand,
  valueMinor,
  quantity,
  currency,
}: GiftCardFulfilledNotificationArgs): Promise<void> => {
  const amount = formatMajorUnits(valueMinor)
  const amountArg =
    quantity > 1 ? `${quantity} x ${amount} ${currency}` : `${amount} ${currency}`
  return sendOutcomeNotificationBestEffort({
    accountId,
    phraseBase: "notification.giftCard.fulfilled",
    dataType: GIFT_CARD_FULFILLED_DATA_TYPE,
    amountArg,
    replacements: { brand },
    extraData: { amount, currency, orderId, brand },
    logMessage: "Failed to send gift card fulfilled push notification",
    logContext: { accountId, orderId },
  })
}
