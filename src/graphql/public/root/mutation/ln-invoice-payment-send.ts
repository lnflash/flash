import { InputValidationError } from "@graphql/error"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
import LnPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import Memo from "@graphql/shared/types/scalar/memo"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import dedent from "dedent"

// FLASH FORK: import ibex dependencies
import { PaymentSendStatus, decodeInvoice } from "@domain/bitcoin/lightning"
import { LnPaymentRequestNonZeroAmountRequiredError } from "@domain/payments/errors"
import Ibex from "@services/ibex/client"
import { IbexError, InsufficientIbexBalance } from "@services/ibex/errors"
import { paymentSendStatusOrPending } from "@services/ibex/payment-status"
import { withPaymentIdempotency } from "@app/payments/idempotency"
import { authorizeSend } from "@app/payments/authorize-send"
import { getSendGuardMode } from "@config"

const LnInvoicePaymentInput = GT.Input({
  name: "LnInvoicePaymentInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description:
        "Wallet ID with sufficient balance to cover amount of invoice.  Must belong to the account of the current user.",
    },
    paymentRequest: {
      type: GT.NonNull(LnPaymentRequest),
      description: "Payment request representing the invoice which is being paid.",
    },
    memo: {
      type: Memo,
      description: "Optional memo to associate with the lightning invoice.",
    },
    idempotencyKey: {
      type: GT.String,
      description:
        "Optional client-supplied key; a repeated send with the same key returns the original result instead of paying again.",
    },
  }),
})

const LnInvoicePaymentSendMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      walletId: WalletId | InputValidationError
      paymentRequest: string | InputValidationError
      memo?: string | InputValidationError
      idempotencyKey?: string | null
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(PaymentSendPayload),
  description: dedent`Pay a lightning invoice using a balance from a wallet which is owned by the account of the current user.
  Provided wallet can be USD or BTC and must have sufficient balance to cover amount in lightning invoice.
  Returns payment status (success, failed, pending, already_paid).`,
  args: {
    input: { type: GT.NonNull(LnInvoicePaymentInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { walletId, paymentRequest, memo, idempotencyKey } = args.input
    if (walletId instanceof InputValidationError) {
      return { errors: [{ message: walletId.message }] }
    }
    if (paymentRequest instanceof InputValidationError) {
      return { errors: [{ message: paymentRequest.message }] }
    }
    if (memo instanceof InputValidationError) {
      return { errors: [{ message: memo.message }] }
    }

    // FLASH FORK: create IBEX invoice instead of Galoy invoice
    /* Todo: reintroduce Payments.payInvoiceByWalletId
     * const status = await Payments.payInvoiceByWalletId({
     *   senderWalletId: walletId,
     *   uncheckedPaymentRequest: paymentRequest,
     *   memo: memo ?? null,
     *   senderAccount: domainAccount,
     */

    if (!domainAccount) throw new Error("Authentication required")

    // ENG-530: dedupe on (senderWalletId, idempotencyKey) when a key is supplied.
    // This resolver pays IBEX directly (the app-layer path is stubbed above), so the
    // idempotency wrapper goes around the inline call here rather than in @app.
    //
    // ENG-573: the guard is the wrapper's `authorize` hook, not a call ahead of
    // it, so a replayed key returns the cached result without spending attempt
    // budget or being re-judged against a moved mid price.
    const status = await withPaymentIdempotency({
      idempotencyKey,
      senderWalletId: walletId,
      requestFingerprint: `ln|${paymentRequest}`,
      authorize: async () => {
        // The bolt11 decode is PART of the guard, not a precondition of it: the
        // guard needs the amount and the amount is inside the invoice. It
        // therefore has to answer to the same switch. `decodeInvoice` refuses
        // any request `invoices.parsePaymentRequest` cannot parse and any
        // invoice with no payment secret — a rejection class this rail never
        // had, since it used to hand the raw bolt11 straight to IBEX. If that
        // gate turns out to refuse an invoice IBEX would have paid, `off` must
        // restore service without a code deploy.
        if (getSendGuardMode() === "off") return true

        const decodedInvoice = decodeInvoice(paymentRequest)
        if (decodedInvoice instanceof Error) return decodedInvoice
        if (decodedInvoice.paymentAmount === null) {
          return new LnPaymentRequestNonZeroAmountRequiredError()
        }

        return authorizeSend({
          senderAccount: domainAccount,
          senderWalletId: walletId,
          amount: { currency: "BTC", sats: decodedInvoice.paymentAmount.amount },
          kind: "lightning",
        })
      },
      execute: async (): Promise<PaymentSendStatus | ApplicationError> => {
        const PayLightningInvoice = await Ibex.payInvoice({
          invoice: paymentRequest as Bolt11,
          accountId: walletId,
        })

        if (PayLightningInvoice instanceof IbexError) {
          return PayLightningInvoice
        }

        return paymentSendStatusOrPending(PayLightningInvoice)
      },
    })

    // TODO: Reintroduce following code by adding to mapAndParseErrorForGqlResponse
    // if (status instanceof IbexRateLimitError) {
    //   return {
    //     status: "failed",
    //     errors: [
    //       {
    //         message:
    //           "Daily transaction limit has been exceeded. Please try again tomorrow.",
    //       },
    //     ],
    //   }
    // }

    // Insufficient balance is actionable for the caller — surface the typed
    // INSUFFICIENT_BALANCE error via the error map instead of the generic
    // catch-all below (issue #93).
    if (status instanceof InsufficientIbexBalance) {
      return { status: "failed", errors: [mapAndParseErrorForGqlResponse(status)] }
    }

    // Preserve the existing generic IBEX-failure message for other IBEX errors.
    if (status instanceof IbexError) {
      return {
        status: "failed",
        errors: [{ message: "An unexpected error occurred. Please try again later." }],
        // errors: [mapAndParseErrorForGqlResponse(status)] }
      }
    }

    // Non-IBEX errors: a concurrent same-key request in flight, or an invalid key.
    if (status instanceof Error) {
      return { status: "failed", errors: [mapAndParseErrorForGqlResponse(status)] }
    }

    return {
      errors: [],
      status: status.value,
    }
  },
})

export default LnInvoicePaymentSendMutation
