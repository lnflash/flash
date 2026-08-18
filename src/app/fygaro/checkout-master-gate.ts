import { FygaroConfig } from "@config"
import { baseLogger } from "@services/logger"

/**
 * The deploy-level gates every card-checkout surface must apply, in ONE place.
 *
 * There are four of them and they are not independent of each other:
 * `fygaro.enabled` (the webhook 503s every delivery without it, so a payment
 * would not even be RECORDED), `fygaro.credit.enabled` (the webhook records and
 * credits nothing), `fygaro.checkout.*` (no button URL or key id means no link
 * can be signed at all — and `checkout.enabled` DEFAULTS TO FALSE), and the
 * presence of the signing secret the key id names.
 *
 * They were previously written out in `authorizeFygaroTopup` and half-copied
 * into `getFygaroTopupAllowance`, which checked the first two and neither of
 * the last two. In the default rollout state — `checkout.enabled` false — that
 * made the allowance query report a healthy number for an account that
 * `fygaroCheckoutCreate` then refused with `checkout-disabled` on every
 * request: the invite-then-refuse failure this workstream exists to end, on
 * the very surface added to end it.
 *
 * A shared predicate is what makes the two agree BY CONSTRUCTION rather than by
 * comment. It hands back the config it gated on, so a caller cannot pass the
 * gate on one set of values and then sign with another.
 */
export type FygaroCheckoutMasterGate =
  | {
      ok: true
      buttonUrl: string
      keyId: string
      secret: string
      ttlSeconds: number
    }
  | { ok: false; reason: "checkout-disabled" }

const DISABLED = { ok: false, reason: "checkout-disabled" } as const

// Matches the webhook's own fallback (payment.ts) so a config missing the field
// cannot make the two sides disagree about how long a link lives.
const DEFAULT_TTL_SECONDS = 900

export const fygaroCheckoutMasterGate = (): FygaroCheckoutMasterGate => {
  if (!FygaroConfig?.enabled || !FygaroConfig?.credit?.enabled) return DISABLED

  const checkout = FygaroConfig.checkout
  if (!checkout?.enabled || !checkout.buttonUrl || !checkout.keyId) return DISABLED

  const secret = FygaroConfig.webhook?.secrets?.[checkout.keyId]
  if (!secret) {
    // Misconfiguration, not a user error: the key id names a secret that is not
    // present. Report it as "disabled" so callers degrade to the legacy flow
    // rather than showing the customer an error we caused.
    baseLogger.error(
      { keyId: checkout.keyId },
      "Fygaro checkout enabled but no signing secret for keyId",
    )
    return DISABLED
  }

  return {
    ok: true,
    buttonUrl: checkout.buttonUrl,
    keyId: checkout.keyId,
    secret,
    ttlSeconds: checkout.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  }
}
