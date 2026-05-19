import { usdWalletAmountFromWalletId, UsdWalletAmount } from "@app/wallets"

import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import CentAmountPayload from "@graphql/public/types/payload/cent-amount"
import LnPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

// FLASH FORK: import ibex dependencies
import Ibex from "@services/ibex/client"

import { IbexError } from "@services/ibex/errors"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
import { IbexFeeEstimation } from "@services/ibex/types"

const LnNoAmountUsdInvoiceFeeProbeInput = GT.Input({
  name: "LnNoAmountUsdInvoiceFeeProbeInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) },
    paymentRequest: { type: GT.NonNull(LnPaymentRequest) },
    amount: { type: GT.NonNull(FractionalCentAmount) },
  }),
})

const LnNoAmountUsdInvoiceFeeProbeMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(CentAmountPayload),
  args: {
    input: { type: GT.NonNull(LnNoAmountUsdInvoiceFeeProbeInput) },
  },
  resolve: async (_, args) => {
    const { walletId, paymentRequest, amount } = args.input

    for (const input of [walletId, paymentRequest, amount]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    // FLASH FORK: create IBEX fee estimation instead of Galoy fee estimation
    // const { result: feeSatAmount, error } =
    //   await Payments.getNoAmountLightningFeeEstimationForUsdWallet({
    //     walletId,
    //     amount,
    //     uncheckedPaymentRequest: paymentRequest,
    //   })

    // TODO: Move Ibex call to Payments interface
    const checkedAmount = await usdWalletAmountFromWalletId({
      walletId,
      amount: amount.toString(),
    })
    if (checkedAmount instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(checkedAmount)] }
    }
    const resp: IbexFeeEstimation<UsdWalletAmount> | IbexError = await Ibex.getLnFeeEstimation({
      invoice: paymentRequest as Bolt11,
      send: checkedAmount,
    })
    if (resp instanceof IbexError) return { errors: [mapAndParseErrorForGqlResponse(resp)] }     

    // if (resp.amount === undefined) return new UnexpectedIbexResponse("Unable to parse fee.")
    // const feeSatAmount: PaymentAmount<WalletCurrency> = {
    //   amount: BigInt(Math.ceil(resp.amount * 100)),
    //   currency: "USD",
    // }

    // if (feeSatAmount === null) {
    //   return {
    //     errors: [mapAndParseErrorForGqlResponse(new InvalidFeeProbeStateError())],
    //   }
    // }

    return {
      errors: [],
      invoiceAmount: resp.invoice,
      amount: resp.fee,
    }
  },
})

export default LnNoAmountUsdInvoiceFeeProbeMutation
