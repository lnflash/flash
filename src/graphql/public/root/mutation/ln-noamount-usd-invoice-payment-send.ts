import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import Memo from "@graphql/shared/types/scalar/memo"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
// import { Payments } from "@app"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
import LnIPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import { InputValidationError } from "@graphql/error"
// import CentAmount from "@graphql/public/types/scalar/cent-amount"
import dedent from "dedent"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"

// FLASH FORK: import ibex dependencies
import { usdWalletAmountFromWalletId } from "@app/wallets"
import { resolveCashWalletMutationWalletIdForAccount } from "@app/cash-wallet-cutover"
import Ibex from "@services/ibex/client"

import { IbexError } from "@services/ibex/errors"
import { withPaymentIdempotency } from "@app/payments/idempotency"
import { paymentSendStatusOrPending } from "@services/ibex/payment-status"

const LnNoAmountUsdInvoicePaymentInput = GT.Input({
  name: "LnNoAmountUsdInvoicePaymentInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description:
        "Wallet ID with sufficient balance to cover amount defined in mutation request.  Must belong to the account of the current user.",
    },
    paymentRequest: {
      type: GT.NonNull(LnIPaymentRequest),
      description: "Payment request representing the invoice which is being paid.",
    },
    amount: {
      type: GT.NonNull(FractionalCentAmount),
      description: "Amount to pay in USD cents.",
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

const LnNoAmountUsdInvoicePaymentSendMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      walletId: WalletId | InputValidationError
      paymentRequest: string | InputValidationError
      amount: FractionalCentAmount | InputValidationError
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
  Provided wallet must be USD and have sufficient balance to cover amount specified in mutation request.
  Returns payment status (success, failed, pending, already_paid).`,
  args: {
    input: { type: GT.NonNull(LnNoAmountUsdInvoicePaymentInput) },
  },
  resolve: async (_, args, { domainAccount, cashWalletClientCapabilities }) => {
    const { walletId, paymentRequest, amount, memo, idempotencyKey } = args.input

    if (walletId instanceof InputValidationError) {
      return { errors: [{ message: walletId.message }] }
    }
    if (paymentRequest instanceof InputValidationError) {
      return { errors: [{ message: paymentRequest.message }] }
    }
    if (amount instanceof InputValidationError) {
      return { errors: [{ message: amount.message }] }
    }
    if (memo instanceof InputValidationError) {
      return { errors: [{ message: memo.message }] }
    }

    // FLASH FORK: create IBEX invoice instead of Galoy invoice
    // const status = await Payments.payNoAmountInvoiceByWalletIdForUsdWallet({
    //   senderWalletId: walletId,
    //   uncheckedPaymentRequest: paymentRequest,
    //   memo: memo ?? null,
    //   amount,
    //   senderAccount: domainAccount,
    // })
    if (!domainAccount) throw new Error("Authentication required")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any

    const routedWalletId = await resolveCashWalletMutationWalletIdForAccount({
      account: domainAccount,
      walletId,
      client: cashWalletClientCapabilities,
    })
    if (routedWalletId instanceof Error) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(routedWalletId)],
      }
    }

    const usCents = await usdWalletAmountFromWalletId({
      walletId: routedWalletId,
      amount: amount.toString(),
    })
    if (usCents instanceof Error) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(usCents)],
      }
    }
    // ENG-533: this resolver executes IBEX directly (FLASH FORK above), so the
    // exactly-once wrapper the covered send functions get in @app/payments
    // never ran here — a double-fire on the most common USD send path
    // double-paid, exactly the 2026-07-23 incident class. Scoped to the ROUTED
    // wallet (the one actually debited) so the same key behaves identically
    // across the cash-wallet compat redirect. Only the money-moving call sits
    // inside execute(); routing and amount conversion stay outside so a cached
    // replay does no IBEX work at all.
    const outcome = await withPaymentIdempotency({
      idempotencyKey,
      senderWalletId: routedWalletId,
      requestFingerprint: `ln-noamount-usd|${paymentRequest}|${amount}`,
      execute: async () => {
        const PayLightningInvoice = await Ibex.payInvoice({
          invoice: paymentRequest as Bolt11,
          accountId: routedWalletId,
          send: usCents,
        })
        if (PayLightningInvoice instanceof IbexError) return PayLightningInvoice
        return paymentSendStatusOrPending(PayLightningInvoice)
      },
    })

    if (outcome instanceof Error) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(outcome)],
      }
    }

    return {
      errors: [],
      status: outcome.value,
    }
  },
})

export default LnNoAmountUsdInvoicePaymentSendMutation
