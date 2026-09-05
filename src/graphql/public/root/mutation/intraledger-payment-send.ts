import { Accounts, Payments } from "@app"
import { authorizeSend } from "@app/payments/authorize-send"
import { resolveCashWalletRecipientMutationWalletId } from "@app/cash-wallet-cutover"
import { checkedToWalletId } from "@domain/wallets"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
import Memo from "@graphql/shared/types/scalar/memo"
import SatAmount from "@graphql/shared/types/scalar/sat-amount"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import dedent from "dedent"

const IntraLedgerPaymentSendInput = GT.Input({
  name: "IntraLedgerPaymentSendInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId), description: "The wallet ID of the sender." }, // TODO: rename senderWalletId
    recipientWalletId: { type: GT.NonNull(WalletId) },
    amount: { type: GT.NonNull(SatAmount), description: "Amount in satoshis." },
    memo: { type: Memo, description: "Optional memo to be attached to the payment." },
    idempotencyKey: {
      type: GT.String,
      description:
        "Optional client-supplied key; a repeated send with the same key returns the original result instead of paying again.",
    },
  }),
})

const IntraLedgerPaymentSendMutation = GT.Field<null, GraphQLPublicContextAuth>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(PaymentSendPayload),
  description: dedent`Actions a payment which is internal to the ledger e.g. it does
  not use onchain/lightning. Returns payment status (success,
  failed, pending, already_paid).`,
  args: {
    input: { type: GT.NonNull(IntraLedgerPaymentSendInput) },
  },
  resolve: async (_, args, { domainAccount, cashWalletClientCapabilities }) => {
    const { walletId, recipientWalletId, amount, memo, idempotencyKey } = args.input
    for (const input of [walletId, recipientWalletId, amount, memo]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    const senderWalletId = checkedToWalletId(walletId)
    if (senderWalletId instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(senderWalletId)] }
    }

    const recipientWalletIdChecked = checkedToWalletId(recipientWalletId)
    if (recipientWalletIdChecked instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(recipientWalletIdChecked)] }
    }

    // ENG-573 send guard: attempt budget + amount sanity + daily-limit cap,
    // before anything reaches IBEX.
    const authorized = await authorizeSend({
      senderAccount: domainAccount,
      senderWalletId: senderWalletId,
      amount: { currency: "BTC", sats: amount },
      kind: "intraledger",
    })
    if (authorized instanceof Error) {
      return { status: "failed", errors: [mapAndParseErrorForGqlResponse(authorized)] }
    }

    // TODO: confirm whether we need to check for username here
    const recipientUsername = await Accounts.getUsernameFromWalletId(
      recipientWalletIdChecked,
    )
    if (recipientUsername instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(recipientUsername)] }
    }

    const routedRecipientWalletId = await resolveCashWalletRecipientMutationWalletId({
      recipientWalletId: recipientWalletIdChecked,
      client: cashWalletClientCapabilities,
    })
    if (routedRecipientWalletId instanceof Error) {
      notifyOpsEvent({
        flow: "transfer",
        phase: "failed",
        status: "failed",
        error: routedRecipientWalletId.constructor.name,
        meta: {
          senderWalletId,
          recipientWalletId: recipientWalletIdChecked,
          reason: "recipient-routing",
        },
      })
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(routedRecipientWalletId)],
      }
    }

    const status = await Payments.intraledgerPaymentSendWalletIdForBtcWallet({
      recipientWalletId: routedRecipientWalletId,
      memo,
      amount,
      senderWalletId,
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

export default IntraLedgerPaymentSendMutation
