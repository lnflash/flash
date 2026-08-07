import { Lightning } from "@app"

import { GT } from "@graphql/index"
import { mapError } from "@graphql/error-map"
import LnInvoicePaymentStatusPayload from "@graphql/public/types/payload/ln-invoice-payment-status"
import LnInvoicePaymentStatusInput from "@graphql/public/types/object/ln-invoice-payment-status-input"

const LnInvoicePaymentStatusQuery = GT.Field({
  type: GT.NonNull(LnInvoicePaymentStatusPayload),
  args: {
    input: { type: GT.NonNull(LnInvoicePaymentStatusInput) },
  },
  resolve: async (_, args) => {
    const { paymentRequest } = args.input
    if (paymentRequest instanceof Error) throw paymentRequest

    const paymentStatusChecker = await Lightning.PaymentStatusChecker(paymentRequest)
    if (paymentStatusChecker instanceof Error) throw mapError(paymentStatusChecker)

    const status = await paymentStatusChecker.status()
    if (status instanceof Error) throw mapError(status)

    return { errors: [], status }
  },
})

export default LnInvoicePaymentStatusQuery
