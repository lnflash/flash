import {
  GiftCardClaimCryptoError,
  GiftCardOrderNotFoundError,
  GiftCardOrderStatus,
} from "@domain/gift-cards"
import { decryptGiftCardClaim } from "@services/gift-cards/claim-crypto"
import { GiftCardOrdersRepository } from "@services/mongoose"
import { addAttributesToCurrentSpan } from "@services/tracing"

export type GiftCardOrderWithClaim = {
  order: GiftCardOrder
  /** Decrypted bearer data. Present only when the order is FULFILLED and the claim decrypted. */
  claim: GiftCardClaim | null
  /**
   * Set when the order is FULFILLED but its stored claim could not be decrypted
   * (key not configured, key rotated, corrupt ciphertext). The order still
   * comes back — the card IS issued and the customer must be able to see that
   * — and the caller decides how to surface the fault. `claim` is null
   * whenever this is set.
   */
  claimError: GiftCardClaimCryptoError | null
}

/**
 * One order, for its owner, with the claim decrypted only once FULFILLED.
 *
 * A non-owner gets `GiftCardOrderNotFoundError`, the same answer as a missing
 * id, so the endpoint cannot be used to confirm that someone else's order
 * exists. The claim is decrypted here and nowhere else; it goes straight into
 * the authenticated response and is never logged or traced.
 *
 * Only "the order cannot be read at all" (missing, not the caller's, repository
 * fault) is returned as an error. A decrypt failure is NOT: the order is real
 * and paid for, so it rides back as data with `claimError` set. Returning the
 * error instead would make a rotated key (or one pod with stale config) hide
 * the order from its owner, who then cannot even see that it exists.
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
    return { order, claim: null, claimError: null }
  }

  const claim = decryptGiftCardClaim({
    ciphertext: order.claimCiphertext,
    keyId: order.claimKeyId,
  })
  if (claim instanceof Error) return { order, claim: null, claimError: claim }

  return { order, claim, claimError: null }
}
