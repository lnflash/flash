import { giftCardsMasterGate, resolveAccountCountryCodeOrUnknown } from "@app/gift-cards"

/**
 * The gate every gift-card root field opens with, in one place.
 *
 * Resolves the routing country (the explicit argument when a field takes one,
 * otherwise the account's), runs `giftCardsMasterGate` on it, and hands back
 * the country it gated on so the caller passes THAT country down — not a
 * second resolution that could disagree with the one the gate saw.
 *
 * Queries throw the mapped error; the mutation returns it in `errors`. Both
 * start here so the catalog can never show what the purchase would refuse.
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
