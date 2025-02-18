import { PayInvoiceV2Response200 } from "./client/.api/apis/sing-in"
import { IbexClientError, UnexpectedIbexResponse } from "./client/errors"
import Ibex from "./client"
import IbexAccount from "./IbexAccount"
import { UnsupportedCurrencyError } from "@domain/errors"

// Currently only supports USD
export const sendBetweenAccounts = async (
  sender: IbexAccount, 
  receiver: IbexAccount, 
  transfer: Amount<"USD">,
  memo: string = "Flash-to-Flash"
): Promise<PayInvoiceV2Response200 | IbexClientError> => {
  if (transfer.currency !== sender.currency || transfer.currency !== receiver.currency)
    return new UnsupportedCurrencyError("Currency for sender, receiver and transfer must match")

  const invoiceResp = await Ibex().addInvoice({ 
    accountId: receiver.id,
    memo: memo || undefined,
    amount: Number(transfer.amount) / 100, // convert cents to dollars for Ibex api
  })
  if (invoiceResp instanceof Error) return invoiceResp
  if (invoiceResp.invoice?.bolt11 === undefined) return new UnexpectedIbexResponse("Bolt11 field not found.")

  return await Ibex().payInvoiceV2({
    accountId: sender.id,
    bolt11: invoiceResp.invoice.bolt11,
  })
}