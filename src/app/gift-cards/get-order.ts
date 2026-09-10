import { GiftCardOrderNotFoundError, GiftCardOrderStatus } from "@domain/gift-cards"
import { decryptGiftCardClaim } from "@services/gift-cards/claim-crypto"
import { GiftCardOrdersRepository } from "@services/mongoose"
import { addAttributesToCurrentSpan } from "@services/tracing"

export type GiftCardOrderWithClaim = {
  order: GiftCardOrder
  /** Decrypted bearer data. Present only when the order is FULFILLED. */
  claim: GiftCardClaim | null
}

/**
 * One order, for its owner, with the claim decrypted only once FULFILLED.
 *
 * A non-owner gets `GiftCardOrderNotFoundError`, the same answer as a missing
 * id, so the endpoint cannot be used to confirm that someone else's order
 * exists. The claim is decrypted here and nowhere else; it goes straight into
 * the authenticated response and is never logged or traced.
 */
export const getGiftCardOrderForAccount = async ({
  accountId,
  orderId,
}: {
  accountId: AccountId
  orderId: GiftCardOrderId
}): Promise<GiftCardOrderWithClaim | ApplicationError> => {
  const order = await GiftCardOrdersRepository().findById(orderId)
  if (order instanceof Error) return order
  if (order.accountId !== accountId) return new GiftCardOrderNotFoundError()

  addAttributesToCurrentSpan({
    "giftcard.orderId": order.id,
    "giftcard.status": order.status,
  })

  if (
    order.status !== GiftCardOrderStatus.Fulfilled ||
    !order.claimCiphertext ||
    !order.claimKeyId
  ) {
    return { order, claim: null }
  }

  const claim = decryptGiftCardClaim({
    ciphertext: order.claimCiphertext,
    keyId: order.claimKeyId,
  })
  if (claim instanceof Error) return claim

  return { order, claim }
}
