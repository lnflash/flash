import IbexClient, { GetFeeEstimateResponse200 } from "ibex-client"
import { errorHandler, IbexError } from "./errors"
import { IBEX_EMAIL, IBEX_PASSWORD, IBEX_URL } from "@config";
import { AddInvoiceBodyParam, AddInvoiceResponse201, CreateAccountResponse201, CreateLnurlPayBodyParam, CreateLnurlPayResponse201, DecodeLnurlMetadataParam, DecodeLnurlResponse200, EstimateFeeCopyMetadataParam, EstimateFeeCopyResponse200, GenerateBitcoinAddressBodyParam, GenerateBitcoinAddressResponse201, GetAccountDetailsMetadataParam, GetAccountDetailsResponse200, GetFeeEstimationMetadataParam, GetFeeEstimationResponse200, GetTransactionDetails1MetadataParam, GetTransactionDetails1Response200, GMetadataParam, GResponse200, InvoiceFromHashMetadataParam, InvoiceFromHashResponse200, PayInvoiceV2BodyParam, PayInvoiceV2Response200, PayToALnurlPayBodyParam, PayToALnurlPayResponse201, SendToAddressCopyBodyParam, SendToAddressCopyResponse200 } from "ibex-client/dist/.api/apis/sing-in";
import { addAttributesToCurrentSpan, wrapAsyncFunctionsToRunInSpan } from "@services/tracing";
import WebhookServer from "./webhook-server";
import USDollars  from "./currencies/USDollars";
import { Redis }  from "./cache"

const Ibex = new IbexClient(
  IBEX_URL, 
  { email: IBEX_EMAIL, password: IBEX_PASSWORD }, 
  Redis
)

const createAccount = async (name: string, currencyId: IbexCurrencyId): Promise<CreateAccountResponse201 | IbexError> => {
  return Ibex.createAccount({ name, currencyId }).then(errorHandler)
}

const getAccountDetails = async (accountId: IbexAccountId): Promise<GetAccountDetailsResponse200 | IbexError> => {
  return Ibex.getAccountDetails({ accountId }).then(errorHandler)
}

const getAccountTransactions = async (params: GetIbexTransactionsArgs): Promise<TransactionResponse | IbexError> => {
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

const getLnFeeEstimation = async (args: GetFeeEstimateArgs): Promise<GetFeeEstimateResponse200 | IbexError> => {
  return Ibex.getFeeEstimation({
    bolt11: args.invoice,
    amount: args.send.amount?.toString(),
    currencyId: args.send.currencyId.toString(),
  }).then(errorHandler) 
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
