import { decodeInvoice } from "@domain/bitcoin/lightning"
import { baseLogger } from "@services/logger"
import Ibex from "@services/ibex"
import { IbexEventError } from "@services/ibex/errors"

export const PaymentStatusChecker = async (uncheckedPaymentRequest: string) => {
  const decodedInvoice = decodeInvoice(uncheckedPaymentRequest)
  if (decodedInvoice instanceof Error) return decodedInvoice

  const { paymentHash, expiresAt, isExpired } = decodedInvoice
  return {
    paymentHash,
    expiresAt,
    isExpired,
    invoiceIsPaid: async (): Promise<boolean | IbexEventError> => {
      const ibexResp = await Ibex.invoiceFromHash({ invoice_hash: paymentHash })
      if (ibexResp instanceof IbexEventError) return ibexResp
      baseLogger.info(ibexResp.status)
      return ibexResp.state?.id === 1 // Invoice states: https://docs.ibexmercado.com/reference/flow#invoice-states-table
    },
  }
}
