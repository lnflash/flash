import { InvalidFeeProbeStateError } from "@domain/bitcoin/lightning"

// import { Payments } from "@app"

import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import CentAmountPayload from "@graphql/public/types/payload/cent-amount"
import LnPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

import { normalizePaymentAmount } from "../../../shared/root/mutation"

// FLASH FORK: import ibex dependencies
import Ibex from "@services/ibex/client"

import { IbexError, UnexpectedIbexResponse } from "@services/ibex/errors"
import { GetFeeEstimateResponse200 } from "ibex-client"
import { checkedToUsdPaymentAmount, ValidationError } from "@domain/shared"
import USDollars from "@services/ibex/currencies/USDollars"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"

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
    const checkedAmount = USDollars.fromFractionalCents(amount as FractionalCentAmount)
    if (checkedAmount instanceof ValidationError) return checkedAmount
    const resp: IbexFeeEstimation<USDollars> | IbexError = await Ibex.getLnFeeEstimation<USDollars>({
      invoice: paymentRequest as Bolt11,
      send: checkedAmount,
    })
    if (resp instanceof IbexError) return { errors: [mapAndParseErrorForGqlResponse(resp)] }     
    const fee = resp.fee.toCents()
    if (fee instanceof ValidationError) return { errors: [mapAndParseErrorForGqlResponse(fee)] }

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
      ...normalizePaymentAmount(fee),
    }
  },
})

export default LnNoAmountUsdInvoiceFeeProbeMutation
