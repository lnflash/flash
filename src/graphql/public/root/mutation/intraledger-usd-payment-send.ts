import { Payments } from "@app"
import { checkedToWalletId } from "@domain/wallets"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
// import CentAmount from "@graphql/public/types/scalar/cent-amount"
import Memo from "@graphql/shared/types/scalar/memo"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import dedent from "dedent"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
// import { RequestInit, Response } from 'node-fetch'
import { EmailService } from "@services/email"

const IntraLedgerUsdPaymentSendInput = GT.Input({
  name: "IntraLedgerUsdPaymentSendInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId), description: "The wallet ID of the sender." }, // TODO: rename senderWalletId
    recipientWalletId: { type: GT.NonNull(WalletId) },
    amount: { type: GT.NonNull(FractionalCentAmount), description: "Amount in cents." },
    memo: { type: Memo, description: "Optional memo to be attached to the payment." },
  }),
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
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    const { walletId, recipientWalletId, amount, memo } = args.input
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

    const status = await Payments.intraledgerPaymentSendWalletIdForUsdWallet({
      recipientWalletId,
      memo,
      amount,
      senderWalletId: walletId,
      senderAccount: domainAccount,
    })
    if (status instanceof Error) {
      return { status: "failed", errors: [mapAndParseErrorForGqlResponse(status)] }
    }

    // Send email notification for successful payment
    if (status.value === "success") {
      // For the sender (user triggering the mutation), use domainAccount
      const senderUsername = domainAccount?.username || "Unknown User"
      // Don't await this to avoid blocking the response
      EmailService().sendLightningTransactionEmail({
        senderWalletId: walletId,
        recipientWalletId,
        senderUsername,
        recipientUsername: "Unknown User",
        senderPhone: "Unknown Phone",
        recipientPhone: "N/A",
        amount,
        memo,
      })
    }

    return {
      errors: [],
      status: status.value,
    }
  },
})

export default IntraLedgerUsdPaymentSendMutation
