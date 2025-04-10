import IbexClient, { GetFeeEstimateResponse200, IbexClientError } from "ibex-client"
import { errorHandler, IbexError, UnexpectedIbexResponse } from "./errors"
import { IbexConfig } from "@config";
import { AddInvoiceBodyParam, AddInvoiceResponse201, CreateAccountResponse201, CreateLnurlPayBodyParam, CreateLnurlPayResponse201, DecodeLnurlMetadataParam, DecodeLnurlResponse200, EstimateFeeCopyMetadataParam, EstimateFeeCopyResponse200, GenerateBitcoinAddressBodyParam, GenerateBitcoinAddressResponse201, GetAccountDetailsMetadataParam, GetAccountDetailsResponse200, GetFeeEstimationMetadataParam, GetFeeEstimationResponse200, GetTransactionDetails1MetadataParam, GetTransactionDetails1Response200, GMetadataParam, GResponse200, InvoiceFromHashMetadataParam, InvoiceFromHashResponse200, PayInvoiceV2BodyParam, PayInvoiceV2Response200, PayToALnurlPayBodyParam, PayToALnurlPayResponse201, SendToAddressCopyBodyParam, SendToAddressCopyResponse200 } from "ibex-client";
import { addAttributesToCurrentSpan, wrapAsyncFunctionsToRunInSpan } from "@services/tracing";
import WebhookServer from "./webhook-server";
import USDollars  from "./currencies/USDollars";
import { Redis }  from "./cache"
import CurrencyMap from "./currencies/CurrencyMap";
import { IbexCurrency } from "./currencies/IbexCurrency";

const Ibex = new IbexClient(
  IbexConfig.url, 
  { email: IbexConfig.email, password: IbexConfig.password }, 
  Redis
)

const createAccount = async (name: string, currencyId: IbexCurrencyId): Promise<CreateAccountResponse201 | IbexError> => {
  return Ibex.createAccount({ name, currencyId }).then(errorHandler)
}

const getAccountDetails = async (accountId: IbexAccountId): Promise<GetAccountDetailsResponse200 | IbexError> => {
  return Ibex.getAccountDetails({ accountId }).then(errorHandler)
}

const getAccountTransactions = async (params: GMetadataParam): Promise<GResponse200 | IbexError> => {
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(params) })
  return Ibex.getAccountTransactions(params).then(errorHandler)
}

const addInvoice = async (args: IbexInvoiceArgs): Promise<AddInvoiceResponse201 | IbexError> => {
  const body = { 
      ...args, 
      amount: args.amount?.amount,
      webhookUrl: WebhookServer.endpoints.onReceive.invoice,
      webhookSecret: WebhookServer.secret, 
  } as AddInvoiceBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
  return Ibex.addInvoice(body).then(errorHandler)
}

const getTransactionDetails = async (id: IbexTransactionId): Promise<GetTransactionDetails1Response200 | IbexError> => {
  return Ibex.getTransactionDetails({ transaction_id: id }).then(errorHandler)
}

const generateBitcoinAddress = async (accountId: IbexAccountId): Promise<GenerateBitcoinAddressResponse201 | IbexError> => {
  return Ibex.generateBitcoinAddress({
    accountId,
    webhookUrl: WebhookServer.endpoints.onReceive.onchain,
    webhookSecret: WebhookServer.secret, 
  }).then(errorHandler)
}

const invoiceFromHash = async (invoice_hash: PaymentHash): Promise<InvoiceFromHashResponse200 | IbexError> => {
  return Ibex.invoiceFromHash({ invoice_hash }).then(errorHandler)
}

const getLnFeeEstimation = async <T extends IbexCurrency>(args: GetFeeEstimateArgs<T>): Promise<IbexFeeEstimation<T> | IbexError> => {
  const currencyId = args.send.currencyId
  const amount = (args.send instanceof IbexCurrency) ? args.send.amount.toString() : undefined 
 
  const resp = await Ibex.getFeeEstimation({
    bolt11: args.invoice as string,
    amount, 
    currencyId: currencyId.toString(),
  })
  if (resp instanceof Error) return new IbexError(resp)
  else if (resp.amount === null || resp.amount === undefined) return new UnexpectedIbexResponse("Fee not found.")
  else if (resp.invoiceAmount === null || resp.invoiceAmount === undefined) return new UnexpectedIbexResponse("invoiceAmount not found.")
  else {
    return {
      fee: CurrencyMap.toIbexCurrency(resp.amount, currencyId) as T,
      invoice: CurrencyMap.toIbexCurrency(resp.invoiceAmount, currencyId) as T,
    }
  }
}

const payInvoice = async (args: PayInvoiceArgs): Promise<PayInvoiceV2Response200 | IbexError> => {
  const bodyWithHooks = { 
      accountId: args.accountId,
      bolt11: args.invoice,
      amount: args.send?.amount,
      webhookUrl: WebhookServer.endpoints.onPay.invoice,
      webhookSecret: WebhookServer.secret, 
  } as PayInvoiceV2BodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return Ibex.payInvoiceV2(bodyWithHooks).then(errorHandler)
}

// onchain transactions are typically high-value
// logging all Ibex responses until we have higher confidence & higher volume
const sendOnchain = async (body: SendToAddressCopyBodyParam): Promise<SendToAddressCopyResponse200 | IbexError> => {
    const bodyWithHooks = { 
        ...body,
        webhookUrl: WebhookServer.endpoints.onPay.onchain,
        webhookSecret: WebhookServer.secret, 
    } as SendToAddressCopyBodyParam
    addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
    return Ibex.sendToAddressV2(bodyWithHooks).then(errorHandler)
}

const estimateOnchainFee = async (send: USDollars, address: OnChainAddress): Promise<EstimateFeeCopyResponse200 | IbexError> => {
  return Ibex.estimateFeeV2({ 
    amount: send.amount, 
    "currency-id": send.currencyId.toString(), 
    address
  }).then(errorHandler)
}
    
const createLnurlPay = async (body: CreateLnurlPayBodyParam): Promise<CreateLnurlPayResponse201 | IbexError> => {
  const bodyWithHooks = { 
      ...body,
      webhookUrl: WebhookServer.endpoints.onReceive.lnurl,
      webhookSecret: WebhookServer.secret, 
  } as CreateLnurlPayBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return Ibex.createLnurlPay(bodyWithHooks).then(errorHandler)
}

const decodeLnurl = async (lnurl: DecodeLnurlMetadataParam): Promise<DecodeLnurlResponse200 | IbexError> => {
  return Ibex.decodeLnurl(lnurl).then(errorHandler)
}
    
const payToLnurl = async (args: PayLnurlArgs): Promise<PayToALnurlPayResponse201 | IbexError> => {
  return Ibex.payToLnurl({
    accountId: args.accountId,
    amount: args.send.amount,
    params: args.params,
    webhookUrl: WebhookServer.endpoints.onPay.lnurl,
    webhookSecret: WebhookServer.secret, 
  }).then(errorHandler)
}

// const sendBetweenAccounts = async (
//   sender: IbexAccount, 
//   receiver: IbexAccount, 
//   transfer: USDollars,
//   memo: string = "Flash-to-Flash"
// ): Promise<PayInvoiceV2Response200 | IbexClientError> => {
//   const invoiceResp = await addInvoice({ 
//     accountId: receiver.id,
//     memo,
//     amount: transfer, // convert cents to dollars for Ibex api
//   })
//   if (invoiceResp instanceof Error) return invoiceResp
//   if (invoiceResp.invoice?.bolt11 === undefined) return new UnexpectedIbexResponse("Bolt11 field not found.")

//   return await payInvoice({
//     accountId: sender.id,
//     invoice: invoiceResp.invoice.bolt11 as Bolt11,
//   })
// }

export default wrapAsyncFunctionsToRunInSpan({
  namespace: "services.ibex.client",
  fns: { 
      getAccountTransactions,
      getTransactionDetails,
      createAccount, 
      getAccountDetails, 
      generateBitcoinAddress, 
      addInvoice, 
      invoiceFromHash, 
      getLnFeeEstimation,
      payInvoice, 
      sendOnchain, 
      estimateOnchainFee, 
      createLnurlPay,
      decodeLnurl,
      payToLnurl
  },
})
