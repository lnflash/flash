import { InvalidFeeProbeStateError } from "@domain/bitcoin/lightning"

import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import SatAmountPayload from "@graphql/public/types/payload/sat-amount"
import LnPaymentRequest from "@graphql/shared/types/scalar/ln-payment-request"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

import { normalizePaymentAmount } from "../../../shared/root/mutation"

// FLASH FORK: import { client as Ibex } dependencies
import Ibex from "@services/ibex/client"
import { GetFeeEstimateResponse200 } from "ibex-client"
import { IbexError } from "@services/ibex/errors" 
import { MSats } from "@services/ibex/currencies"
import { checkedToBtcPaymentAmount, paymentAmountFromNumber, ValidationError, ZERO_SATS } from "@domain/shared"
import { Pay } from "twilio/lib/twiml/VoiceResponse"

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
  resolve: async (_, args) => {
    const { walletId, paymentRequest } = args.input

    if (walletId instanceof Error) return { errors: [{ message: walletId.message }] }

    if (paymentRequest instanceof Error)
      return { errors: [{ message: paymentRequest.message }] }

    const resp: IbexFeeEstimation<MSats> | IbexError = await Ibex.getLnFeeEstimation<MSats>({
      invoice: paymentRequest as Bolt11,
      send: { currencyId: MSats.currencyId }, 
    })

    const error: Error | null = resp instanceof IbexError 
      ? resp
      : null

    let feeSatAmount: BtcPaymentAmount
    if (resp instanceof IbexError) feeSatAmount = ZERO_SATS
    else {
      const fee = resp.fee.toSats()
      if (fee instanceof Error) feeSatAmount = ZERO_SATS
      else feeSatAmount = fee
    }
    // const fee = resp.fee.toSats()
    // const feeSatAmount: PaymentAmount<WalletCurrency> = (!(resp instanceof IbexError)) 
      // ? 
      // : {
      //   amount: BigInt(0),
      //   currency: "BTC",
      // }

    if (feeSatAmount !== null && error instanceof Error) {
      return {
        errors: [mapAndParseErrorForGqlResponse(error)],
        ...normalizePaymentAmount(feeSatAmount),
      }
    }

    if (error instanceof Error) {
      return {
        errors: [mapAndParseErrorForGqlResponse(error)],
      }
    }

    if (feeSatAmount === null) {
      return {
        errors: [mapAndParseErrorForGqlResponse(new InvalidFeeProbeStateError())],
      }
    }

    return {
      errors: [],
      ...normalizePaymentAmount(feeSatAmount),
    }
  },
})

export default LnInvoiceFeeProbeMutation
