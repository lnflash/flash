import { Accounts, Payments } from "@app"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { checkedToWalletId } from "@domain/wallets"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import Memo from "@graphql/shared/types/scalar/memo"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { client as Ibex } from "@services/ibex"
import { IbexApiError, UnexpectedResponseError } from "@services/ibex/client/errors"
import dedent from "dedent"
// import { RequestInit, Response } from 'node-fetch'

const IntraLedgerUsdPaymentSendInput = GT.Input({
  name: "IntraLedgerUsdPaymentSendInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId), description: "The wallet ID of the sender." }, // TODO: rename senderWalletId
    recipientWalletId: { type: GT.NonNull(WalletId) },
    amount: { type: GT.NonNull(CentAmount), description: "Amount in cents." },
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
  
  Flash: We do not currently have an internal ledger. Consequently, this endpoint has been updated to call Ibex instead.`,
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

    // TODO: confirm whether we need to check for username here
    // const recipientUsername = await Accounts.getUsernameFromWalletId(
    //   recipientWalletIdChecked,
    // )
    // if (recipientUsername instanceof Error) {
    //   return { errors: [mapAndParseErrorForGqlResponse(recipientUsername)] }
    // }
   
   
    // bob: 3ba88684-3b13-4282-83cf-79de50445368
    const recipientLnurlp = await Accounts.getLnurlpFromWalletId(
      recipientWalletIdChecked,
    )
    if (recipientLnurlp instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(recipientLnurlp)] }
    }
    console.log("LNURLP = " + recipientLnurlp)
   
    // decode Lnurl can probably be done locally to extract k1
    const decodeResp = await Ibex().decodeLnurl({ lnurl: recipientLnurlp })
    if (decodeResp instanceof Error) return { errors: [mapAndParseErrorForGqlResponse(decodeResp)] }
    if (!decodeResp.decodedLnurl) return { errors: [mapAndParseErrorForGqlResponse(new UnexpectedResponseError("Decoded Lnurl not found."))]}
    console.log("decoded = " + JSON.stringify(decodeResp))

    const paramsResp = await fetch(decodeResp.decodedLnurl as unknown as URL)
    const payResp = await Ibex().payToLnurl({
      params: await paramsResp.json(),
      amount: amount / 100, // convert cents to dollars for Ibex api
      accountId: walletId, 
    })
    if (payResp instanceof Error) return { errors: [mapAndParseErrorForGqlResponse(payResp)] }
    console.log(payResp)

    // https://docs.ibexmercado.com/reference/flow-1#payment-status
    let status: PaymentSendStatus 
    switch(payResp.transaction?.payment?.statusId) {
      case 1:
        status = PaymentSendStatus.Pending 
        break;
      case 2:
        status = PaymentSendStatus.Success 
        break;
      case 3:
        status = PaymentSendStatus.Failure
        break;
      case 0: 
        return { errors: [mapAndParseErrorForGqlResponse(new UnexpectedResponseError("Lnurl-pay already paid"))]}
      default:
        return { errors: [mapAndParseErrorForGqlResponse(new UnexpectedResponseError("StatusId not in documenation"))]}
    }

    // TODO: MOVE ABOVE LOGIC IN HERE

    // const status = await Payments.intraledgerPaymentSendWalletIdForUsdWallet({
    //   recipientWalletId,
    //   memo,
    //   amount,
    //   senderWalletId: walletId,
    //   senderAccount: domainAccount,
    // })
    // if (status instanceof Error) {
    //   return { status: "failed", errors: [mapAndParseErrorForGqlResponse(status)] }
    // }
    // END TODO

    return {
      errors: [],
      status: status.value,
    }
  },
})

export default IntraLedgerUsdPaymentSendMutation
