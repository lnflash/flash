import IbexClient, { ApiError, AuthenticationError, GetFeeEstimateResponse200 } from "ibex-client"
import { IbexClientError } from "./errors"
import { IBEX_EMAIL, IBEX_PASSWORD, IBEX_URL } from "@config";
import { AddInvoiceBodyParam, AddInvoiceResponse201, CreateAccountResponse201, CreateLnurlPayBodyParam, CreateLnurlPayResponse201, DecodeLnurlMetadataParam, DecodeLnurlResponse200, EstimateFeeCopyMetadataParam, EstimateFeeCopyResponse200, GenerateBitcoinAddressBodyParam, GenerateBitcoinAddressResponse201, GetAccountDetailsMetadataParam, GetAccountDetailsResponse200, GetFeeEstimationMetadataParam, GetFeeEstimationResponse200, GetTransactionDetails1MetadataParam, GetTransactionDetails1Response200, GMetadataParam, GResponse200, InvoiceFromHashMetadataParam, InvoiceFromHashResponse200, PayInvoiceV2BodyParam, PayInvoiceV2Response200, PayToALnurlPayBodyParam, PayToALnurlPayResponse201, SendToAddressCopyBodyParam, SendToAddressCopyResponse200 } from "ibex-client/dist/.api/apis/sing-in";
import { addAttributesToCurrentSpan, addEventToCurrentSpan, wrapAsyncFunctionsToRunInSpan } from "@services/tracing";
import WebhookServer from "./webhook-server";
import USDollars  from "./currencies/USDollars";
import { Redis }  from "./cache"

const Ibex = new IbexClient(
  IBEX_URL, 
  { email: IBEX_EMAIL, password: IBEX_PASSWORD }, 
  Redis
)

const createAccount = async (name: string, currencyId: IbexCurrencyId): Promise<CreateAccountResponse201 | IbexClientError> => {
  return Ibex.createAccount({ name, currencyId } )
}

const getAccountDetails = async (accountId: IbexAccountId): Promise<GetAccountDetailsResponse200 | AuthenticationError | ApiError> => {
  return Ibex.getAccountDetails({ accountId })
}

const getAccountTransactions = async (params: GetIbexTransactionsArgs): Promise<TransactionResponse | IbexClientError> => {
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(params) })
  return Ibex.getAccountTransactions(params)
}

const addInvoice = async (args: IbexInvoiceArgs): Promise<AddInvoiceResponse201 | IbexClientError> => {
  const body = { 
      ...args, 
      amount: args.amount?.amount,
      webhookUrl: WebhookServer.endpoints.onReceive.invoice,
      webhookSecret: WebhookServer.secret, 
  } as AddInvoiceBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
  return Ibex.addInvoice(body)
}

const getTransactionDetails = async (id: IbexTransactionId): Promise<GetTransactionDetails1Response200 | IbexClientError> => {
  return Ibex.getTransactionDetails({ transaction_id: id })
}

const generateBitcoinAddress = async (accountId: IbexAccountId): Promise<GenerateBitcoinAddressResponse201 | IbexClientError> => {
  return Ibex.generateBitcoinAddress({
    accountId,
    webhookUrl: WebhookServer.endpoints.onReceive.onchain,
    webhookSecret: WebhookServer.secret, 
  })
}

const invoiceFromHash = async (invoice_hash: PaymentHash): Promise<InvoiceFromHashResponse200 | IbexClientError> => {
  return Ibex.invoiceFromHash({ invoice_hash })
}

const getLnFeeEstimation = async (args: GetFeeEstimateArgs): Promise<GetFeeEstimateResponse200 | IbexClientError> => {
  return await Ibex.getFeeEstimation({
    bolt11: args.invoice,
    amount: args.send.amount?.toString(),
    currencyId: args.send.currencyId.toString(),
  }) 
}

const payInvoice = async (args: PayInvoiceArgs): Promise<PayInvoiceV2Response200 | IbexClientError> => {
  const bodyWithHooks = { 
      accountId: args.accountId,
      bolt11: args.invoice,
      amount: args.send?.amount,
      webhookUrl: WebhookServer.endpoints.onPay.invoice,
      webhookSecret: WebhookServer.secret, 
  } as PayInvoiceV2BodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return Ibex.payInvoiceV2(bodyWithHooks)
}

// onchain transactions are typically high-value
// logging all Ibex responses until we have higher confidence & higher volume
const sendOnchain = async (body: SendToAddressCopyBodyParam): Promise<SendToAddressCopyResponse200 | IbexClientError> => {
    const bodyWithHooks = { 
        ...body,
        webhookUrl: WebhookServer.endpoints.onPay.onchain,
        webhookSecret: WebhookServer.secret, 
    } as SendToAddressCopyBodyParam
    addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
    const resp = await Ibex.sendToAddressV2(bodyWithHooks)
    if (resp instanceof IbexClientError) return resp
    
    addEventToCurrentSpan("IbexResponse", { response: JSON.stringify(resp) })
    return resp
}

const estimateOnchainFee = async (send: USDollars, address: OnChainAddress): Promise<EstimateFeeCopyResponse200 | IbexClientError> => {
  return Ibex.estimateFeeV2({ 
    amount: send.amount, 
    "currency-id": send.currencyId.toString(), 
    address
  })
}
    
const createLnurlPay = async (body: CreateLnurlPayBodyParam): Promise<CreateLnurlPayResponse201 | IbexClientError> => {
  const bodyWithHooks = { 
      ...body,
      webhookUrl: WebhookServer.endpoints.onReceive.lnurl,
      webhookSecret: WebhookServer.secret, 
  } as CreateLnurlPayBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return Ibex.createLnurlPay(bodyWithHooks)
}

const decodeLnurl = async (lnurl: DecodeLnurlMetadataParam): Promise<DecodeLnurlResponse200 | IbexClientError> => {
  return Ibex.decodeLnurl(lnurl)
}
    
const payToLnurl = async (args: PayLnurlArgs): Promise<PayToALnurlPayResponse201 | IbexClientError> => {
  return Ibex.payToLnurl({
    accountId: args.accountId,
    amount: args.send.amount,
    params: args.params,
    webhookUrl: WebhookServer.endpoints.onPay.lnurl,
    webhookSecret: WebhookServer.secret, 
  })
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
