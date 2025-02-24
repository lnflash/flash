import { InvalidFeeProbeStateError } from "@domain/bitcoin/lightning"

// import { Payments } from "@app"

import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import CentAmountPayload from "@graphql/public/types/payload/sat-amount"
import LnPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

import { checkedToWalletId } from "@domain/wallets"

import { normalizePaymentAmount } from "../../../shared/root/mutation"

// FLASH FORK: import ibex dependencies
import Ibex from "@services/ibex/client"

import { IbexClientError, UnexpectedResponseError } from "ibex-client"
import { WalletCurrency } from "@domain/shared"
import USDollars from "@services/ibex/currencies/USDollars"
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

    const resp: any = await Ibex.getLnFeeEstimation({
      invoice: paymentRequest as Bolt11,
      send: { currencyId: USDollars.currencyId } 
    })
    if (resp instanceof IbexClientError) return { errors: [mapAndParseErrorForGqlResponse(resp)] }     
    if (resp.amount === null || resp.amount === undefined) return { errors: [mapAndParseErrorForGqlResponse(new UnexpectedResponseError("Amount field not found."))] }

    return {
      errors: [],
      ...normalizePaymentAmount({
        amount: BigInt(Math.ceil(resp.amount * 100)),
        currency: WalletCurrency.Usd, 
      }),
    }
  },
})

export default LnUsdInvoiceFeeProbeMutation
