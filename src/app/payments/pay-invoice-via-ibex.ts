import type { PayInvoiceV2Response200 } from "ibex-client"

import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { paymentSendStatusOrPending } from "@services/ibex/payment-status"

import { withPaymentIdempotency } from "./idempotency"

/**
 * Pay a BOLT11 invoice from a Flash wallet over the IBEX-custodial rail.
 *
 * This is the rail Flash actually runs on. `lnInvoicePaymentSend` pays IBEX
 * inline from its resolver (src/graphql/public/root/mutation/ln-invoice-payment-send.ts);
 * this is that `withPaymentIdempotency({ authorize, execute })` block lifted
 * into @app so other use cases (gift cards, ENG-580) pay the same way with the
 * same idempotency and send-guard semantics. `payInvoiceByWalletId` in
 * ./send-lightning.ts is the upstream-galoy LND rail: dormant on this
 * deployment (no LND nodes), kept for upstream parity only.
 *
 * On this rail the IBEX account id IS the Flash wallet id.
 *
 * `onResponse` hands the raw IBEX 200 to the caller before it is reduced to a
 * `PaymentSendStatus`. It exists to keep `transaction.id`, the one handle the
 * gift-card reconcile worker has to re-query an in-flight send
 * (`Ibex.getTransactionDetails`). It runs only when IBEX was actually called —
 * never on an idempotent replay — and it is awaited inside the lock, so it must
 * be cheap and must not throw: a throw here would turn a payment that has
 * already moved money into an uncached error a same-key retry could re-pay.
 */
export type PayLnInvoiceViaIbexArgs = {
  senderWalletId: WalletId
  senderAccount: Account
  paymentRequest: string
  idempotencyKey: string
  requestFingerprint: string
  authorize: SendGuardHook
  onResponse?: (response: PayInvoiceV2Response200) => void
}

export const payLnInvoiceViaIbex = async ({
  senderWalletId,
  paymentRequest,
  idempotencyKey,
  requestFingerprint,
  authorize,
  onResponse,
}: PayLnInvoiceViaIbexArgs): Promise<PaymentSendStatus | ApplicationError> =>
  withPaymentIdempotency({
    idempotencyKey,
    senderWalletId,
    requestFingerprint,
    authorize,
    execute: async (): Promise<PaymentSendStatus | ApplicationError> => {
      const response = await Ibex.payInvoice({
        invoice: paymentRequest as Bolt11,
        accountId: senderWalletId,
      })

      if (response instanceof IbexError) return response

      onResponse?.(response)
      return paymentSendStatusOrPending(response)
    },
  })
