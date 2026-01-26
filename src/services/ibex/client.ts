import IbexClient, { GetFeeEstimateResponse200, IbexClientError } from "ibex-client"
import { errorHandler, IbexError, ParseError, UnexpectedIbexResponse } from "./errors"
import { IbexConfig } from "@config"
import {
  AddInvoiceBodyParam,
  AddInvoiceResponse201,
  CreateAccountResponse201,
  CreateLnurlPayBodyParam,
  CreateLnurlPayResponse201,
  DecodeLnurlMetadataParam,
  DecodeLnurlResponse200,
  EstimateFeeCopyMetadataParam,
  EstimateFeeCopyResponse200,
  GenerateBitcoinAddressBodyParam,
  GenerateBitcoinAddressResponse201,
  GetAccountDetailsMetadataParam,
  GetAccountDetailsResponse200,
  GetFeeEstimationMetadataParam,
  GetFeeEstimationResponse200,
  GetTransactionDetails1MetadataParam,
  GetTransactionDetails1Response200,
  GMetadataParam,
  GResponse200,
  InvoiceFromHashMetadataParam,
  InvoiceFromHashResponse200,
  PayInvoiceV2BodyParam,
  PayInvoiceV2Response200,
  PayToALnurlPayBodyParam,
  PayToALnurlPayResponse201,
  SendToAddressCopyBodyParam,
  SendToAddressCopyResponse200,
} from "ibex-client"
import {
  addAttributesToCurrentSpan,
  wrapAsyncFunctionsToRunInSpan,
} from "@services/tracing"
import WebhookServer from "./webhook-server"
import { Redis } from "./cache"
import {
  GetFeeEstimateArgs,
  IbexAccountDetails,
  IbexFeeEstimation,
  IbexInvoiceArgs,
  PayInvoiceArgs,
  CryptoReceiveOption,
  CryptoReceiveInfo,
  CreateCryptoReceiveInfoRequest,
} from "./types"
import { USDAmount, USDTAmount } from "@domain/shared"
import { baseLogger } from "@services/logger"

const Ibex = new IbexClient(
  IbexConfig.url,
  { email: IbexConfig.email, password: IbexConfig.password },
  Redis,
)

const createAccount = async (
  name: string,
  currencyId: IbexCurrencyId,
): Promise<CreateAccountResponse201 | IbexError> => {
  return Ibex.createAccount({ name, currencyId }).then(errorHandler)
}

const getAccountDetails = async (
  accountId: IbexAccountId,
): Promise<IbexAccountDetails | IbexError> => {
  return Ibex.getAccountDetails({ accountId })
    .then((r) => {
      if (r instanceof Error) return r
      else {
        let balance =
          r.balance !== undefined ? USDAmount.dollars(r.balance.toString()) : undefined
        if (balance instanceof Error) balance = undefined
        return {
          id: r.id,
          userId: r.userId,
          name: r.name,
          balance,
        }
      }
    })
    .then(errorHandler)
}

const getAccountTransactions = async (
  params: GMetadataParam,
): Promise<GResponse200 | IbexError> => {
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(params) })
  return Ibex.getAccountTransactions(params).then(errorHandler)
}

const addInvoice = async (
  args: IbexInvoiceArgs,
): Promise<AddInvoiceResponse201 | IbexError> => {
  const body = {
    ...args,
    amount: args.amount?.toIbex(),
    webhookUrl: WebhookServer.endpoints.onReceive.invoice,
    webhookSecret: WebhookServer.secret,
  } as AddInvoiceBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
  return Ibex.addInvoice(body).then(errorHandler)
}

const getTransactionDetails = async (
  id: IbexTransactionId,
): Promise<GetTransactionDetails1Response200 | IbexError> => {
  return Ibex.getTransactionDetails({ transaction_id: id }).then(errorHandler)
}

const generateBitcoinAddress = async (
  accountId: IbexAccountId,
): Promise<GenerateBitcoinAddressResponse201 | IbexError> => {
  return Ibex.generateBitcoinAddress({
    accountId,
    webhookUrl: WebhookServer.endpoints.onReceive.onchain,
    webhookSecret: WebhookServer.secret,
  }).then(errorHandler)
}

const invoiceFromHash = async (
  invoice_hash: PaymentHash,
): Promise<InvoiceFromHashResponse200 | IbexError> => {
  return Ibex.invoiceFromHash({ invoice_hash }).then(errorHandler)
}

// Only supports USD for now
const getLnFeeEstimation = async (
  args: GetFeeEstimateArgs,
): Promise<IbexFeeEstimation | IbexError> => {
  const currencyId = USDAmount.currencyId
  // const amount = (args.send instanceof IbexCurrency) ? args.send.amount.toString() : undefined

  const resp = await Ibex.getFeeEstimation({
    bolt11: args.invoice as string,
    amount: args.send?.asDollars(8),
    currencyId: currencyId.toString(),
  })
  if (resp instanceof Error) return new IbexError(resp)
  else if (resp.amount === null || resp.amount === undefined)
    return new UnexpectedIbexResponse("Fee not found.")
  else if (resp.invoiceAmount === null || resp.invoiceAmount === undefined)
    return new UnexpectedIbexResponse("invoiceAmount not found.")
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

const payInvoice = async (
  args: PayInvoiceArgs,
): Promise<PayInvoiceV2Response200 | IbexError> => {
  const bodyWithHooks = {
    accountId: args.accountId,
    bolt11: args.invoice,
    amount: args.send?.toIbex(),
    webhookUrl: WebhookServer.endpoints.onPay.invoice,
    webhookSecret: WebhookServer.secret,
  } as PayInvoiceV2BodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return Ibex.payInvoiceV2(bodyWithHooks).then(errorHandler)
}

// onchain transactions are typically high-value
// logging all Ibex responses until we have higher confidence & higher volume
const sendOnchain = async (
  body: SendToAddressCopyBodyParam,
): Promise<SendToAddressCopyResponse200 | IbexError> => {
  const bodyWithHooks = {
    ...body,
    webhookUrl: WebhookServer.endpoints.onPay.onchain,
    webhookSecret: WebhookServer.secret,
  } as SendToAddressCopyBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return Ibex.sendToAddressV2(bodyWithHooks).then(errorHandler)
}

const estimateOnchainFee = async (
  send: USDAmount,
  address: OnChainAddress,
): Promise<EstimateFeeCopyResponse200 | IbexError> => {
  return Ibex.estimateFeeV2({
    "amount": send.toIbex(),
    "currency-id": USDAmount.currencyId.toString(),
    address,
  }).then(errorHandler)
}

const createLnurlPay = async (
  body: CreateLnurlPayBodyParam,
): Promise<CreateLnurlPayResponse201 | IbexError> => {
  const bodyWithHooks = {
    ...body,
    webhookUrl: WebhookServer.endpoints.onReceive.lnurl,
    webhookSecret: WebhookServer.secret,
  } as CreateLnurlPayBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return Ibex.createLnurlPay(bodyWithHooks).then(errorHandler)
}

const decodeLnurl = async (
  lnurl: DecodeLnurlMetadataParam,
): Promise<DecodeLnurlResponse200 | IbexError> => {
  return Ibex.decodeLnurl(lnurl).then(errorHandler)
}

const payToLnurl = async (
  args: PayLnurlArgs,
): Promise<PayToALnurlPayResponse201 | IbexError> => {
  return Ibex.payToLnurl({
    accountId: args.accountId,
    amount: args.send.amount,
    params: args.params,
    webhookUrl: WebhookServer.endpoints.onPay.lnurl,
    webhookSecret: WebhookServer.secret,
  }).then(errorHandler)
}

const getCryptoReceiveBalance = async (
  receiveInfoId: string,
): Promise<USDTAmount | IbexError> => {
  try {
    const resp = await (Ibex as any).getCryptoReceiveBalance({ receiveInfoId })
    if (resp instanceof Error) return new IbexError(resp)
    if (resp.balance === null || resp.balance === undefined)
      return new UnexpectedIbexResponse("Balance not found")
    const balance = USDTAmount.smallestUnits(resp.balance.toString())
    if (balance instanceof Error) return new IbexError(balance)
    return balance
  } catch (err) {
    return new IbexError(err instanceof Error ? err : new Error(String(err)))
  }
}

const getCryptoReceiveOptions = async (): Promise<CryptoReceiveOption[] | IbexError> => {
  try {
    const resp = await (Ibex as any).getCryptoReceiveOptions()
    if (resp instanceof Error) return new IbexError(resp)
    return resp.options || []
  } catch (err) {
    return new IbexError(err instanceof Error ? err : new Error(String(err)))
  }
}

const createCryptoReceiveInfo = async (
  walletId: IbexAccountId,
  optionId: string,
): Promise<CryptoReceiveInfo | IbexError> => {
  try {
    const resp = await (Ibex as any).createCryptoReceiveInfo({
      wallet_id: walletId,
      option_id: optionId,
    } as CreateCryptoReceiveInfoRequest)
    if (resp instanceof Error) return new IbexError(resp)
    if (!resp.address) return new UnexpectedIbexResponse("Address not found")
    return resp
  } catch (err) {
    return new IbexError(err instanceof Error ? err : new Error(String(err)))
  }
}

const getTronUsdtOption = async (): Promise<string | IbexError> => {
  const options = await getCryptoReceiveOptions()
  if (options instanceof IbexError) return options

  const tronUsdt = options.find(
    (opt) =>
      opt.currency.toLowerCase() === "usdt" && opt.network.toLowerCase() === "tron",
  )

  if (!tronUsdt) {
    return new IbexError(new Error("Tron USDT option not found"))
  }

  return tronUsdt.id
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
    payToLnurl,
    getCryptoReceiveBalance,
    getCryptoReceiveOptions,
    createCryptoReceiveInfo,
    getTronUsdtOption,
  },
})
