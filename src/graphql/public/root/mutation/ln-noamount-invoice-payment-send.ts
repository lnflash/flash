import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import Memo from "@graphql/shared/types/scalar/memo"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import SatAmount from "@graphql/shared/types/scalar/sat-amount"
import { Payments } from "@app"
import { authorizeSend } from "@app/payments/authorize-send"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
import LnIPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import { InputValidationError } from "@graphql/error"
import dedent from "dedent"

const LnNoAmountInvoicePaymentInput = GT.Input({
  name: "LnNoAmountInvoicePaymentInput",
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
      type: GT.NonNull(SatAmount),
      description: "Amount to pay in satoshis.",
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

const LnNoAmountInvoicePaymentSendMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      walletId: WalletId | InputValidationError
      paymentRequest: string | InputValidationError
      amount: Satoshis | InputValidationError
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
  Provided wallet must be BTC and must have sufficient balance to cover amount specified in mutation request.
  Returns payment status (success, failed, pending, already_paid).`,
  args: {
    input: { type: GT.NonNull(LnNoAmountInvoicePaymentInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
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

    // ENG-573 send guard: attempt budget + amount sanity + daily-limit cap,
    // before anything reaches IBEX.
    const authorized = await authorizeSend({
      senderAccount: domainAccount,
      senderWalletId: walletId,
      amount: { currency: "BTC", sats: amount },
      kind: "lightning",
    })
    if (authorized instanceof Error) {
      return { status: "failed", errors: [mapAndParseErrorForGqlResponse(authorized)] }
    }

    const status = await Payments.payNoAmountInvoiceByWalletIdForBtcWallet({
      senderWalletId: walletId,
      uncheckedPaymentRequest: paymentRequest,
      memo: memo ?? null,
      amount,
      senderAccount: domainAccount,
      idempotencyKey,
    })

    if (status instanceof Error) {
      return { status: "failed", errors: [mapAndParseErrorForGqlResponse(status)] }
    }

    return {
      errors: [],
      status: status.value,
    }
  },
})

export default LnNoAmountInvoicePaymentSendMutation
