import { GT } from "@graphql/index"
import SatAmountPayload from "@graphql/public/types/payload/sat-amount"
import LnPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

// FLASH FORK: import { client as Ibex } dependencies
import { NotImplementedError } from "@domain/errors"

const LnInvoiceFeeProbeInput = GT.Input({
  name: "LnInvoiceFeeProbeInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) },
    paymentRequest: { type: GT.NonNull(LnPaymentRequest) },
  }),
})

const LnInvoiceFeeProbeMutation = GT.Field<
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
  type: GT.NonNull(SatAmountPayload),
  args: {
    input: { type: GT.NonNull(LnInvoiceFeeProbeInput) },
  },
  resolve: async () => {
    return new NotImplementedError("LnInvoiceFeeProbeMutation")

    //   const { walletId, paymentRequest } = args.input

    //   if (walletId instanceof Error) return { errors: [{ message: walletId.message }] }

    //   if (paymentRequest instanceof Error)
    //     return { errors: [{ message: paymentRequest.message }] }

    //   const resp: IbexFeeEstimation<MSats> | IbexError = await Ibex.getLnFeeEstimation<MSats>({
    //     invoice: paymentRequest as Bolt11,
    //     send: { currencyId: MSats.currencyId },
    //   })

    //   const error: Error | null = resp instanceof IbexError
    //     ? resp
    //     : null

    //   let feeSatAmount: BtcPaymentAmount
    //   if (resp instanceof IbexError) feeSatAmount = ZERO_SATS
    //   else {
    //     const fee = resp.fee.toSats()
    //     if (fee instanceof Error) feeSatAmount = ZERO_SATS
    //     else feeSatAmount = fee
    //   }
    //   // const fee = resp.fee.toSats()
    //   // const feeSatAmount: PaymentAmount<WalletCurrency> = (!(resp instanceof IbexError))
    //     // ?
    //     // : {
    //     //   amount: BigInt(0),
    //     //   currency: "BTC",
    //     // }

    //   if (feeSatAmount !== null && error instanceof Error) {
    //     return {
    //       errors: [mapAndParseErrorForGqlResponse(error)],
    //       ...normalizePaymentAmount(feeSatAmount),
    //     }
    //   }

    //   if (error instanceof Error) {
    //     return {
    //       errors: [mapAndParseErrorForGqlResponse(error)],
    //     }
    //   }

    //   if (feeSatAmount === null) {
    //     return {
    //       errors: [mapAndParseErrorForGqlResponse(new InvalidFeeProbeStateError())],
    //     }
    //   }

    //   return {
    //     errors: [],
    //     ...normalizePaymentAmount(feeSatAmount),
    //   }
  },
})

export default LnInvoiceFeeProbeMutation
