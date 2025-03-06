import { decodeInvoice } from "@domain/bitcoin/lightning"
import { baseLogger } from "@services/logger"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { ErrorLevel } from "@domain/shared"

export const PaymentStatusChecker = async (uncheckedPaymentRequest: string) => {
  const decodedInvoice = decodeInvoice(uncheckedPaymentRequest)
  if (decodedInvoice instanceof Error) return decodedInvoice

  const { paymentHash, expiresAt, isExpired } = decodedInvoice
  return {
    paymentHash,
    expiresAt,
    isExpired,
    // invoiceIsPaid should have no awareness of Ibex. TODO: add to Wallets interface
    invoiceIsPaid: async (): Promise<boolean | IbexError> => {
      const ibexResp = await Ibex.invoiceFromHash(paymentHash)
      if (ibexResp instanceof IbexError) return ibexResp
      baseLogger.info(ibexResp.status)
      return ibexResp.state?.id === 1 // Invoice states: https://docs.ibexmercado.com/reference/flow#invoice-states-table
    },
  }
}
