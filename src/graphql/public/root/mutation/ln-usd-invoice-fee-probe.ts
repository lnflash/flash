import { InvalidFeeProbeStateError } from "@domain/bitcoin/lightning"

// import { Payments } from "@app"

import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import CentAmountPayload from "@graphql/public/types/payload/cent-amount"
import LnPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

import { checkedToWalletId } from "@domain/wallets"

import { normalizePaymentAmount } from "../../../shared/root/mutation"

// FLASH FORK: import ibex dependencies
import Ibex from "@services/ibex/client"

import { IbexError, UnexpectedIbexResponse } from "@services/ibex/errors"
import { ValidationError, WalletCurrency } from "@domain/shared"
import USDollars from "@services/ibex/currencies/USDollars"
import { baseLogger } from "@services/logger"
// import { IbexRoutes } from "../../../../services/ibex/Routes"
// import { requestIBexPlugin } from "../../../../services/ibex/IbexHelper"

const LnUsdInvoiceFeeProbeInput = GT.Input({
  name: "LnUsdInvoiceFeeProbeInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) },
    paymentRequest: { type: GT.NonNull(LnPaymentRequest) },
  }),
})

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

    const resp = await Ibex.getLnFeeEstimation<USDollars>({
      invoice: paymentRequest as Bolt11,
      send: { currencyId: USDollars.currencyId },
    })
    if (resp instanceof IbexError) return { errors: [mapAndParseErrorForGqlResponse(resp)] }     
    const fee = resp.fee.toCents()
    if (fee instanceof ValidationError) return { errors: [mapAndParseErrorForGqlResponse(fee)] }
    
    return {
      errors: [],
      ...normalizePaymentAmount(fee),
    }
  },
})

export default LnUsdInvoiceFeeProbeMutation
