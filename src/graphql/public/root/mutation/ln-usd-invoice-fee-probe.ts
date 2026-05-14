import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import CentAmountPayload from "@graphql/public/types/payload/cent-amount"
import LnPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

import { checkedToWalletId } from "@domain/wallets"

import Ibex from "@services/ibex/client"

import { IbexError } from "@services/ibex/errors"
import { WalletsRepository } from "@services/mongoose"
// import { IbexRoutes } from "../../../../services/ibex/Routes"
// import { requestIBexPlugin } from "../../../../services/ibex/IbexHelper"

const LnUsdInvoiceFeeProbeInput = GT.Input({
  name: "LnUsdInvoiceFeeProbeInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) },
    paymentRequest: { type: GT.NonNull(LnPaymentRequest) },
  }),
})

// const UsdFeeProbeResponse = GT.Object({
//   name: "UsdInvoiceEstimate",
//   fields: () => ({
//     errors: {
//       type: GT.NonNullList(IError),
//     },
//     invoiceAmount: {
//       type: USDCentsScalar,
//     },
//     fee: {
//       type: USDCentsScalar,
//     },
//   }),
// })

const LnUsdInvoiceFeeProbeMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      walletId: WalletId | InputValidationError
      paymentRequest: string | InputValidationError
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(CentAmountPayload),
  args: {
    input: { type: GT.NonNull(LnUsdInvoiceFeeProbeInput) },
  },
  resolve: async (_, args) => {
    const { walletId, paymentRequest } = args.input

    if (walletId instanceof Error) {
      return { errors: [{ message: walletId.message }] }
    }

    if (paymentRequest instanceof Error) {
      return { errors: [{ message: paymentRequest.message }] }
    }

    const walletIdChecked = checkedToWalletId(walletId)
    if (walletIdChecked instanceof Error)
      return { errors: [mapAndParseErrorForGqlResponse(walletIdChecked)] }

    // FLASH FORK: create IBEX fee estimation instead of Galoy fee estimation
    // const { result: feeSatAmount, error } =
    //   await Payments.getLightningFeeEstimationForUsdWallet({
    //     walletId,
    //     uncheckedPaymentRequest: paymentRequest,
    //   })

    const wallet = await WalletsRepository().findById(walletIdChecked)
    if (wallet instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(wallet)] }
    }

    const resp = await Ibex.getLnFeeEstimation({
      invoice: paymentRequest as Bolt11,
      currency: wallet.currency,
    })
    if (resp instanceof IbexError) return { errors: [mapAndParseErrorForGqlResponse(resp)] }     
    
    return {
      errors: [],
      invoiceAmount: resp.invoice,
      amount: resp.fee,
    }
  },
})

export default LnUsdInvoiceFeeProbeMutation
