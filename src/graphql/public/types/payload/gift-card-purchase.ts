import { GT } from "@graphql/index"
import GiftCardOrder from "@graphql/public/types/object/gift-card-order"
import IError from "@graphql/shared/types/abstract/error"

const GiftCardPurchasePayload = GT.Object({
  name: "GiftCardPurchasePayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    order: {
      type: GiftCardOrder,
      description:
        "The order, in whatever state the purchase reached before returning — often " +
        "already FULFILLED with the claim attached, sometimes still PAID or " +
        "PAYMENT_PENDING. Poll giftCardOrder(id:) while the status is transient. " +
        "Absent when the purchase was refused before an order existed; may be present " +
        "ALONGSIDE an error when the card was issued but its claim could not be read.",
    },
  }),
})

export default GiftCardPurchasePayload
