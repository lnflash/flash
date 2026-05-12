import IbexClient, {
  AddInvoiceBodyParam,
  AddInvoiceResponse201,
  CreateAccountResponse201,
  CreateLnurlPayBodyParam,
  CreateLnurlPayResponse201,
  DecodeLnurlMetadataParam,
  DecodeLnurlResponse200,
  EstimateFeeCopyResponse200,
  GenerateBitcoinAddressResponse201,
  GetTransactionDetails1Response200,
  GMetadataParam,
  GResponse200,
  InvoiceFromHashResponse200,
  PayInvoiceV2BodyParam,
  PayInvoiceV2Response200,
  PayToALnurlPayResponse201,
  SendToAddressCopyBodyParam,
  SendToAddressCopyResponse200,
} from "ibex-client"

import { IbexConfig } from "@config"
import {
  addAttributesToCurrentSpan,
  wrapAsyncFunctionsToRunInSpan,
} from "@services/tracing"

import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"

import { baseLogger } from "@services/logger"

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

import { errorHandler, IbexError, ParseError, UnexpectedIbexResponse } from "./errors"
import WebhookServer from "./webhook-server"

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

const parseAccountBalance = (
  balance: number | undefined,
  currency: WalletCurrency,
): IbexAccountDetails["balance"] => {
  if (balance === undefined) return undefined

  const amount =
    currency === WalletCurrency.Usdt
      ? USDTAmount.fromNumber(balance.toString())
      : USDAmount.dollars(balance.toString())

  return amount instanceof Error ? undefined : amount
}

const getAccountDetails = async (
  accountId: IbexAccountId,
  currency: WalletCurrency = WalletCurrency.Usd,
): Promise<IbexAccountDetails | IbexError> => {
  return Ibex.getAccountDetails({ accountId })
    .then((resp) => {
      if (resp instanceof Error) return resp

      return {
        id: resp.id,
        userId: resp.userId,
        name: resp.name,
        balance: parseAccountBalance(resp.balance, currency),
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
    const fee = USDAmount.dollars(resp.amount)
    if (fee instanceof Error) return new ParseError(fee)
    const invoiceAmount = USDAmount.dollars(resp.invoiceAmount)
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

const getIbexToken = async (): Promise<string | IbexError> => {
  const cached = await Ibex.authentication.storage.getAccessToken()
  if (typeof cached === "string") return `Bearer ${cached}`

  // The SDK uses a single base URL for all calls, but the sandbox auth domain is separate
  const resp = await fetch(`${IbexConfig.url}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: IbexConfig.email, password: IbexConfig.password }),
  }).catch(
    (err: unknown) => new IbexError(err instanceof Error ? err : new Error(String(err))),
  )

  if (resp instanceof IbexError) return resp
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    return new IbexError(new Error(`IBEX sign-in failed: ${resp.status} — ${body}`))
  }

  const data = (await resp.json()) as {
    accessToken?: string
    accessTokenExpiresAt?: number
    refreshToken?: string
    refreshTokenExpiresAt?: number
  }
  if (!data.accessToken)
    return new IbexError(new Error("IBEX sign-in: no access token in response"))

  await Ibex.authentication.storage.setAccessToken(
    data.accessToken,
    data.accessTokenExpiresAt,
  )
  if (data.refreshToken) {
    await Ibex.authentication.storage.setRefreshToken(
      data.refreshToken,
      data.refreshTokenExpiresAt,
    )
  }

  return `Bearer ${data.accessToken}`
}

const ibexFetch = async <T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T | IbexError> => {
  const url = `${IbexConfig.url}${path}`
  const resp = await fetch(url, {
    ...init,
    headers: {
      "Authorization": token,
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    baseLogger.error({ url, status: resp.status, body }, "IBEX request failed")
    return new IbexError(new Error(`IBEX ${path} failed: ${resp.status} — ${body}`))
  }
  return resp.json() as Promise<T>
}

const ibexGet = <T>(token: string, path: string) =>
  ibexFetch<T>(token, path, { method: "GET" })

const ibexPost = <T>(token: string, path: string, body: unknown) =>
  ibexFetch<T>(token, path, { method: "POST", body: JSON.stringify(body) })

const getCryptoReceiveBalance = async (
  receiveInfoId: string,
): Promise<USDTAmount | IbexError> => {
  try {
    const token = await getIbexToken()
    if (token instanceof IbexError) return token
    const data = await ibexGet<{ balance: number }>(
      token,
      `/crypto/receive-infos/${receiveInfoId}/balance`,
    )
    if (data instanceof IbexError) return data
    const balance = USDTAmount.smallestUnits(data.balance?.toString())
    if (balance instanceof Error) return new IbexError(balance)
    return balance
  } catch (err) {
    return new IbexError(err instanceof Error ? err : new Error(String(err)))
  }
}

const getCryptoReceiveOptions = async (): Promise<CryptoReceiveOption[] | IbexError> => {
  try {
    const token = await getIbexToken()
    if (token instanceof IbexError) return token
    const data = await ibexGet<{ options: CryptoReceiveOption[] }>(
      token,
      "/crypto/receive-infos/options",
    )
    if (data instanceof IbexError) return data
    return data.options || []
  } catch (err) {
    return new IbexError(err instanceof Error ? err : new Error(String(err)))
  }
}

const createCryptoReceiveInfo = async (
  accountId: IbexAccountId,
  option: Pick<CryptoReceiveOption, "name" | "network">,
): Promise<CryptoReceiveInfo | IbexError> => {
  try {
    const token = await getIbexToken()
    if (token instanceof IbexError) return token
    const data = await ibexPost<CryptoReceiveInfo>(
      token,
      `/accounts/${accountId}/crypto/receive-infos`,
      { name: option.name, network: option.network } as CreateCryptoReceiveInfoRequest,
    )
    if (data instanceof IbexError) return data
    if (!data.address) return new UnexpectedIbexResponse("Address not found")
    return data
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

const getEthereumUsdtOption = async (): Promise<CryptoReceiveOption | IbexError> => {
  const options = await getCryptoReceiveOptions()
  if (options instanceof IbexError) return options

  const ethereumUsdt = options.find(
    (opt) =>
      opt.currency.toLowerCase() === "usdt" && opt.network.toLowerCase() === "ethereum",
  )

  if (!ethereumUsdt) {
    return new IbexError(new Error("Ethereum USDT option not found"))
  }

  return ethereumUsdt
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
    getEthereumUsdtOption,
  },
})
