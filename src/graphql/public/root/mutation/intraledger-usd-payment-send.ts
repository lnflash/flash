import { Payments } from "@app"
import {
  resolveCashWalletMutationWalletIdForAccount,
  resolveCashWalletRecipientMutationWalletId,
} from "@app/cash-wallet-cutover"
import { checkedToWalletId } from "@domain/wallets"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
// import CentAmount from "@graphql/public/types/scalar/cent-amount"
import Memo from "@graphql/shared/types/scalar/memo"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import dedent from "dedent"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
// import { RequestInit, Response } from 'node-fetch'

const IntraLedgerUsdPaymentSendInput = GT.Input({
  name: "IntraLedgerUsdPaymentSendInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId), description: "The wallet ID of the sender." }, // TODO: rename senderWalletId
    recipientWalletId: { type: GT.NonNull(WalletId) },
    amount: { type: GT.NonNull(FractionalCentAmount), description: "Amount in cents." },
    memo: { type: Memo, description: "Optional memo to be attached to the payment." },
    idempotencyKey: {
      type: GT.String,
      description:
        "Optional client-supplied key; a repeated send with the same key returns the original result instead of paying again.",
    },
  }),
})

const notifyCashWalletRoutingFailure = ({
  error,
  senderWalletId,
  recipientWalletId,
  amount,
  reason,
}: {
  error: ApplicationError
  senderWalletId: string
  recipientWalletId: string
  amount: number
  reason: "sender-routing" | "recipient-routing"
}): void =>
  notifyOpsEvent({
    flow: "transfer",
    phase: "failed",
    status: "failed",
    error: error.constructor.name,
    amount: { value: (Number(amount) / 100).toFixed(2), currency: "USD" },
    meta: { senderWalletId, recipientWalletId, reason },
  })

const IntraLedgerUsdPaymentSendMutation = GT.Field<null, GraphQLPublicContextAuth>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(PaymentSendPayload),
  description: dedent`Galoy: Actions a payment which is internal to the ledger e.g. it does
  not use onchain/lightning. Returns payment status (success,
  failed, pending, already_paid).
  
  Flash: We do not currently have an internal ledger. Consequently, intraledger payments have been updated to call Ibex instead.`,
  args: {
    input: { type: GT.NonNull(IntraLedgerUsdPaymentSendInput) },
  },
  resolve: async (
    _,
    args,
    { domainAccount, cashWalletClientCapabilities }: GraphQLPublicContextAuth,
  ) => {
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

    const routedSenderWalletId = await resolveCashWalletMutationWalletIdForAccount({
      account: domainAccount,
      walletId: senderWalletId,
      client: cashWalletClientCapabilities,
    })
    if (routedSenderWalletId instanceof Error) {
      notifyCashWalletRoutingFailure({
        error: routedSenderWalletId,
        senderWalletId,
        recipientWalletId: recipientWalletIdChecked,
        amount,
        reason: "sender-routing",
      })
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(routedSenderWalletId)],
      }
    }

    const routedRecipientWalletId = await resolveCashWalletRecipientMutationWalletId({
      recipientWalletId: recipientWalletIdChecked,
      client: cashWalletClientCapabilities,
    })
    if (routedRecipientWalletId instanceof Error) {
      notifyCashWalletRoutingFailure({
        error: routedRecipientWalletId,
        senderWalletId: routedSenderWalletId,
        recipientWalletId: recipientWalletIdChecked,
        amount,
        reason: "recipient-routing",
      })
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(routedRecipientWalletId)],
      }
    }

    const status = await Payments.intraledgerPaymentSendWalletIdForUsdWallet({
      recipientWalletId: routedRecipientWalletId,
      memo,
      amount,
      senderWalletId: routedSenderWalletId,
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

export default IntraLedgerUsdPaymentSendMutation
