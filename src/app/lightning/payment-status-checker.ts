import { decodeInvoice } from "@domain/bitcoin/lightning"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"

// Invoice states: https://docs.ibexmercado.com/reference/flow#invoice-states-table
const IBEX_INVOICE_STATE_SETTLED = 1
const HTTP_NOT_FOUND = 404

export type InvoicePaymentStatus = "PAID" | "PENDING" | "EXPIRED"

export const PaymentStatusChecker = async (uncheckedPaymentRequest: string) => {
  const decodedInvoice = decodeInvoice(uncheckedPaymentRequest)
  if (decodedInvoice instanceof Error) return decodedInvoice

  const { paymentHash, expiresAt, isExpired } = decodedInvoice
  return {
    paymentHash,
    expiresAt,
    isExpired,
    // status should have no awareness of Ibex. TODO: add to Wallets interface
    status: async (): Promise<InvoicePaymentStatus | IbexError> => {
      const ibexResp = await Ibex.invoiceFromHash(paymentHash)
      if (ibexResp instanceof IbexError) {
        // IBEX purges invoices some time after they expire. A 404 for an
        // invoice that is already past its own expiry is therefore a
        // terminal EXPIRED, not a server error — without this, clients
        // polling an old invoice never receive a terminal status and
        // retry forever (observed as 15+ days of 1/min from-hash 404s
        // at IBEX's edge).
        if (ibexResp.httpCode === HTTP_NOT_FOUND && isExpired) return "EXPIRED"
        return ibexResp
      }
      baseLogger.info(ibexResp.status)
      if (ibexResp.state?.id === IBEX_INVOICE_STATE_SETTLED) return "PAID"
      return isExpired ? "EXPIRED" : "PENDING"
    },
  }
}
