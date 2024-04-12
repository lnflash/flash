import { decodeInvoice } from "@domain/bitcoin/lightning"
import { baseLogger } from "@services/logger"
import { client as Ibex } from "@services/ibex"
import { IbexClientError } from "@services/ibex/client/errors"

export const PaymentStatusChecker = async (uncheckedPaymentRequest: string) => {
  const decodedInvoice = decodeInvoice(uncheckedPaymentRequest)
  if (decodedInvoice instanceof Error) return decodedInvoice

  const { paymentHash, expiresAt, isExpired } = decodedInvoice
  return {
    paymentHash,
    expiresAt,
    isExpired,
    // invoiceIsPaid should have no awareness of Ibex. TODO: add to Wallets interface
    invoiceIsPaid: async (): Promise<boolean | IbexClientError> => {
      const ibexResp = await Ibex().invoiceFromHash({ invoice_hash: paymentHash })
      if (ibexResp instanceof IbexClientError) return ibexResp
      baseLogger.info(ibexResp.status)
      return ibexResp.state?.id === 1 // Invoice states: https://docs.ibexmercado.com/reference/flow#invoice-states-table
    },
  }
}
