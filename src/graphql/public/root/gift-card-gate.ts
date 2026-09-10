import { giftCardsMasterGate, resolveAccountCountryCodeOrUnknown } from "@app/gift-cards"

/**
 * The gate the catalog, quote, and purchase root fields open with, in one place.
 *
 * `giftCardOrder` / `giftCardOrders` deliberately do NOT use it: they are
 * owner-scoped reads of orders the customer already paid for, and switching the
 * rail off must never hide codes they own.
 *
 * Resolves the routing country (the explicit argument when a field takes one,
 * otherwise the account's), runs `giftCardsMasterGate` on it, and hands back
 * the country it gated on so the caller passes THAT country down — not a
 * second resolution that could disagree with the one the gate saw.
 *
 * Gated queries throw the mapped error; the mutation returns it in `errors`.
 * Both start here so the catalog can never show what the purchase would refuse.
 */
export type GiftCardGate =
  | { ok: true; providerId: GiftCardProviderId; countryCode: string }
  | {
      ok: false
      error: Extract<ReturnType<typeof giftCardsMasterGate>, { ok: false }>["error"]
      countryCode: string
    }

export const gateGiftCardsForAccount = async ({
  account,
  countryCode,
}: {
  account: Pick<Account, "id" | "kratosUserId">
  countryCode?: string
}): Promise<GiftCardGate> => {
  const cc = countryCode ?? (await resolveAccountCountryCodeOrUnknown(account))
  const gate = giftCardsMasterGate(cc)
  return gate.ok
    ? { ok: true, providerId: gate.providerId, countryCode: cc }
    : { ok: false, error: gate.error, countryCode: cc }
}
