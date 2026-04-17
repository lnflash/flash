import IbexClient, { GetFeeEstimateResponse200, IbexClientError } from "ibex-client"
import { errorHandler, IbexError, ParseError, UnexpectedIbexResponse } from "./errors"
import { IbexConfig } from "@config";
import { AddInvoiceBodyParam, AddInvoiceResponse201, CreateAccountResponse201, CreateLnurlPayBodyParam, CreateLnurlPayResponse201, DecodeLnurlMetadataParam, DecodeLnurlResponse200, EstimateFeeCopyMetadataParam, EstimateFeeCopyResponse200, GenerateBitcoinAddressBodyParam, GenerateBitcoinAddressResponse201, GetAccountDetailsMetadataParam, GetAccountDetailsResponse200, GetFeeEstimationMetadataParam, GetFeeEstimationResponse200, GetTransactionDetails1MetadataParam, GetTransactionDetails1Response200, GMetadataParam, GResponse200, InvoiceFromHashMetadataParam, InvoiceFromHashResponse200, PayInvoiceV2BodyParam, PayInvoiceV2Response200, PayToALnurlPayBodyParam, PayToALnurlPayResponse201, SendToAddressCopyBodyParam, SendToAddressCopyResponse200 } from "ibex-client";
import { addAttributesToCurrentSpan, wrapAsyncFunctionsToRunInSpan } from "@services/tracing";
import WebhookServer from "./webhook-server";
import { Redis }  from "./cache"
import { GetFeeEstimateArgs, IbexAccountDetails, IbexFeeEstimation, IbexInvoiceArgs, PayInvoiceArgs, SendOnchainArgs } from "./types";
import { USDAmount } from "@domain/shared";

// Lazy IBEX client initialization - non-fatal if IBEX is unreachable at startup
let _ibexClient: InstanceType<typeof IbexClient> | null = null
let _ibexAvailable = true

const getIbexClient = (): InstanceType<typeof IbexClient> | null => {
  if (_ibexClient) return _ibexClient
  if (!_ibexAvailable) return null
  try {
    _ibexClient = new IbexClient(
      IbexConfig.url,
      { email: IbexConfig.email, password: IbexConfig.password },
      Redis,
    )
    return _ibexClient
  } catch (err) {
    _ibexAvailable = false
    return null
  }
}

// Wrapper to handle IBEX unavailability
const withIbex = <T>(fn: (ibex: InstanceType<typeof IbexClient>) => Promise<T | IbexError>) => {
  return async (): Promise<T | IbexError> => {
    const ibex = getIbexClient()
    if (!ibex) {
      return new (require("./errors").IbexUnavailableError)()
    }
    return fn(ibex)
  }
}

const createAccount = async (name: string, currencyId: IbexCurrencyId): Promise<CreateAccountResponse201 | IbexError> => {
  const ibex = getIbexClient()
  if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  return ibex.createAccount({ name, currencyId }).then(errorHandler)
}

const getAccountDetails = async (accountId: IbexAccountId): Promise<IbexAccountDetails | IbexError> => {
  const ibex = getIbexClient()
  if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  return ibex.getAccountDetails({ accountId })
    .then(r => {
      if (r instanceof Error) return r
      else {
        let balance = r.balance !== undefined ? USDAmount.dollars(r.balance.toString()) : undefined
        if (balance instanceof Error) balance = undefined
        return {
          id: r.id,
          userId: r.userId,
          name: r.name,
          balance
        }
      }
    })
    .then(errorHandler)
}

const getAccountTransactions = async (params: GMetadataParam): Promise<GResponse200 | IbexError> => {
  const ibex = getIbexClient()
  if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(params) })
  return ibex.getAccountTransactions(params).then(errorHandler)
}

const addInvoice = async (args: IbexInvoiceArgs): Promise<AddInvoiceResponse201 | IbexError> => {
  const ibex = getIbexClient()
  if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  const body = { 
      ...args, 
      amount: args.amount?.toIbex(), 
      webhookUrl: WebhookServer.endpoints.onReceive.invoice,
      webhookSecret: WebhookServer.secret, 
  } as AddInvoiceBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
  return ibex.addInvoice(body).then(errorHandler)
}

const getTransactionDetails = async (id: IbexTransactionId): Promise<GetTransactionDetails1Response200 | IbexError> => {
  const ibex = getIbexClient()
  if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  return ibex.getTransactionDetails({ transaction_id: id }).then(errorHandler)
}

const generateBitcoinAddress = async (accountId: IbexAccountId): Promise<GenerateBitcoinAddressResponse201 | IbexError> => {
  const ibex = getIbexClient()
  if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  return ibex.generateBitcoinAddress({
    accountId,
    webhookUrl: WebhookServer.endpoints.onReceive.onchain,
    webhookSecret: WebhookServer.secret, 
  }).then(errorHandler)
}

const invoiceFromHash = async (invoice_hash: PaymentHash): Promise<InvoiceFromHashResponse200 | IbexError> => {
  const ibex = getIbexClient()
  if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  return ibex.invoiceFromHash({ invoice_hash }).then(errorHandler)
}

// Only supports USD for now
const getLnFeeEstimation = async (args: GetFeeEstimateArgs): Promise<IbexFeeEstimation | IbexError> => {
  const ibex = getIbexClient()
  if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  const currencyId = USDAmount.currencyId
  // const amount = (args.send instanceof IbexCurrency) ? args.send.amount.toString() : undefined 
 
  const resp = await ibex.getFeeEstimation({
    bolt11: args.invoice as string,
    amount: args.send?.asDollars(8), 
    currencyId: currencyId.toString(),
  })
  if (resp instanceof Error) return new IbexError(resp)
  else if (resp.amount === null || resp.amount === undefined) return new UnexpectedIbexResponse("Fee not found.")
  else if (resp.invoiceAmount === null || resp.invoiceAmount === undefined) return new UnexpectedIbexResponse("invoiceAmount not found.")
  else {
    let fee = USDAmount.dollars(resp.amount)
    if (fee instanceof Error) return new ParseError(fee)
    let invoiceAmount = USDAmount.dollars(resp.invoiceAmount)
    if (invoiceAmount instanceof Error) return new ParseError(invoiceAmount)
    return { 
      fee, 
      invoice: invoiceAmount,
    }
  }
}

const payInvoice = async (args: PayInvoiceArgs): Promise<PayInvoiceV2Response200 | IbexError> => {
  const ibex = getIbexClient()
  if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  const bodyWithHooks = { 
      accountId: args.accountId,
      bolt11: args.invoice,
      amount: args.send?.toIbex(),
      webhookUrl: WebhookServer.endpoints.onPay.invoice,
      webhookSecret: WebhookServer.secret, 
  } as PayInvoiceV2BodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return ibex.payInvoiceV2(bodyWithHooks).then(errorHandler)
}

// onchain transactions are typically high-value
// logging all Ibex responses until we have higher confidence & higher volume
const sendOnchain = async (args: SendOnchainArgs): Promise<SendToAddressCopyResponse200 | IbexError> => {
    const ibex = getIbexClient(); if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
    const body = { 
        accountId: args.accountId,
        address: args.address,
        amount: args.amount.toIbex(),
        webhookUrl: WebhookServer.endpoints.onPay.onchain,
        webhookSecret: WebhookServer.secret, 
    } as SendToAddressCopyBodyParam
    addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
    return ibex.sendToAddressV2(body).then(errorHandler)
}

const estimateOnchainFee = async (send: USDAmount, address: OnChainAddress): Promise<EstimateFeeCopyResponse200 | IbexError> => {
  const ibex = getIbexClient(); if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  return ibex.estimateFeeV2({ 
    amount: send.toIbex(), 
    "currency-id": USDAmount.currencyId.toString(), 
    address
  }).then(errorHandler)
}
    
const createLnurlPay = async (body: CreateLnurlPayBodyParam): Promise<CreateLnurlPayResponse201 | IbexError> => {
  const ibex = getIbexClient(); if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  const bodyWithHooks = { 
      ...body,
      webhookUrl: WebhookServer.endpoints.onReceive.lnurl,
      webhookSecret: WebhookServer.secret, 
  } as CreateLnurlPayBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return ibex.createLnurlPay(bodyWithHooks).then(errorHandler)
}

const decodeLnurl = async (lnurl: DecodeLnurlMetadataParam): Promise<DecodeLnurlResponse200 | IbexError> => {
  const ibex = getIbexClient(); if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  return ibex.decodeLnurl(lnurl).then(errorHandler)
}
    
const payToLnurl = async (args: PayLnurlArgs): Promise<PayToALnurlPayResponse201 | IbexError> => {
  const ibex = getIbexClient(); if (!ibex) { const { IbexUnavailableError } = require('./errors'); return new IbexUnavailableError() }
  return ibex.payToLnurl({
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