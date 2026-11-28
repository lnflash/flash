import { RecordedSignal } from "@app/pos-usdt-checkout/checkout"

import { flashUsdtCheckout } from "./flash"

export type PosUsdtHubOutcome =
  | RecordedSignal
  | { result: "disabled"; readBack?: undefined }

/**
 * A signed IBEX Hub "Transactions" delivery for a crypto receive, handed on
 * by the hub route after the Bridge path has been started. The body is the
 * one the signature covered.
 *
 * Resolves once the credit is durably stored, or the event is known not to
 * need storing, without any IBEX read: the route acknowledges only then.
 * Throws when storage failed, so the route can ask IBEX to redeliver. The
 * returned `readBack` confirms a stored credit against IBEX; the route runs
 * it after acknowledging.
 */
export async function recordPosUsdtHubEvent(body: unknown): Promise<PosUsdtHubOutcome> {
  const service = flashUsdtCheckout()
  if (!service) return { result: "disabled" }
  return service.record(body)
}
