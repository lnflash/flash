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
  IbexUrls,
  CryptoReceiveInfo,
  CryptoReceiveOption,
} from "ibex-client"

import { IbexConfig } from "@config"
import {
  addAttributesToCurrentSpan,
  wrapAsyncFunctionsToRunInSpan,
} from "@services/tracing"

import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"

import { baseLogger } from "@services/logger"

import { cappedIbexReceiveExpiration } from "@domain/bitcoin/lightning"

import { Redis } from "./cache"
import {
  GetFeeEstimateArgs,
  IbexAccountDetails,
  IbexFeeEstimation,
  IbexInvoiceArgs,
  PayInvoiceArgs,
  CreateCryptoSendInfoBodyParam,
  CryptoSendBodyParam,
  CryptoSendInfo,
  CryptoSendRequirements,
  CryptoSendResponse,
  UsdWalletAmount,
} from "./types"

import { errorHandler, IbexError, ParseError, UnexpectedIbexResponse } from "./errors"
import { ibexWebhookEndpoints, ibexWebhookSecret } from "./webhook-config"

const Ibex = new IbexClient(
  {
    clientId: IbexConfig.clientId,
    clientSecret: IbexConfig.clientSecret,
    environment: IbexConfig.environment,
  },
  Redis,
)

const IbexUrlConfig = IbexUrls[IbexConfig.environment]
const mockIbexEnabled =
  IbexConfig.mock === true && process.env.FLASH_ENABLE_IBEX_MOCK === "true"
const mockLnurl =
  "lnurl1dp68gurn8ghj7um9dej8xct5w3skccne9e3k7mf0d3h82unvwqhkxun0wa5kgct5v93kzmmfd3skjmn0wvhxcmmv9u"

const createAccount = async (
  name: string,
  currencyId: IbexCurrencyId,
): Promise<CreateAccountResponse201 | IbexError> => {
  if (mockIbexEnabled) {
    return {
      id: `quickstart-${name}-${currencyId}`,
      name,
      currencyId,
    } as CreateAccountResponse201
  }

  return Ibex.createAccount({ name, currencyId }).then(errorHandler)
}

const ibexCurrencyIdForUsdAmount = (amount: UsdWalletAmount): IbexCurrencyId => {
  if (amount instanceof USDAmount) return USDAmount.currencyId
  return USDTAmount.currencyId
}

const ibexCurrencyIdForUsdWalletCurrency = (
  currency?: WalletCurrency,
): IbexCurrencyId => {
  if (currency === WalletCurrency.Usdt) return USDTAmount.currencyId
  return USDAmount.currencyId
}

const parseIbexUsdAmount = (
  amount: number | string,
  currencyId: IbexCurrencyId,
): UsdWalletAmount | ParseError => {
  const parsed =
    currencyId === USDTAmount.currencyId
      ? USDTAmount.fromNumber(amount.toString())
      : USDAmount.dollars(amount.toString())

  return parsed instanceof Error ? new ParseError(parsed) : parsed
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
    // IBEX silently caps non-msat receive invoices at 60s; never request more.
    // See IBEX_RECEIVE_MAX_EXPIRATION_SECONDS (ENG-427).
    expiration: cappedIbexReceiveExpiration(args.expiration),
    webhookUrl: ibexWebhookEndpoints.onReceive.invoice,
    webhookSecret: ibexWebhookSecret,
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
    webhookUrl: ibexWebhookEndpoints.onReceive.onchain,
    webhookSecret: ibexWebhookSecret,
  }).then(errorHandler)
}

const invoiceFromHash = async (
  invoice_hash: PaymentHash,
): Promise<InvoiceFromHashResponse200 | IbexError> => {
  return Ibex.invoiceFromHash({ invoice_hash }).then(errorHandler)
}

const getLnFeeEstimation = async (
  args: GetFeeEstimateArgs,
): Promise<IbexFeeEstimation<UsdWalletAmount> | IbexError> => {
  const currencyId = args.send
    ? ibexCurrencyIdForUsdAmount(args.send)
    : ibexCurrencyIdForUsdWalletCurrency(args.currency)

  const resp = await Ibex.getFeeEstimation({
    bolt11: args.invoice as string,
    amount: args.send?.toIbex().toString(),
    currencyId: currencyId.toString(),
  })
  if (resp instanceof Error) return new IbexError(resp)
  else if (resp.amount === null || resp.amount === undefined)
    return new UnexpectedIbexResponse("Fee not found.")
  else if (resp.invoiceAmount === null || resp.invoiceAmount === undefined)
    return new UnexpectedIbexResponse("invoiceAmount not found.")
  else {
    const fee = parseIbexUsdAmount(resp.amount, currencyId)
    if (fee instanceof Error) return fee
    const invoiceAmount = parseIbexUsdAmount(resp.invoiceAmount, currencyId)
    if (invoiceAmount instanceof Error) return invoiceAmount
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
    webhookUrl: ibexWebhookEndpoints.onPay.invoice,
    webhookSecret: ibexWebhookSecret,
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
    webhookUrl: ibexWebhookEndpoints.onPay.onchain,
    webhookSecret: ibexWebhookSecret,
  } as SendToAddressCopyBodyParam
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
  return Ibex.sendToAddressV2(bodyWithHooks).then(errorHandler)
}

const sendCrypto = async (
  body: CryptoSendBodyParam,
): Promise<CryptoSendResponse | IbexError> => {
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
  const token = await getIbexToken()
  if (token instanceof IbexError) return token

  const { accountId, ...cryptoSendBody } = body
  return ibexPost<CryptoSendResponse>(
    token,
    `/accounts/${encodeURIComponent(accountId)}/crypto/send`,
    cryptoSendBody,
  )
}

const getCryptoSendRequirements = async (args: {
  network: string
  currencyId: IbexCurrencyId
}): Promise<CryptoSendRequirements | IbexError> => {
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(args) })
  const token = await getIbexToken()
  if (token instanceof IbexError) return token

  const query = new URLSearchParams()
  query.set("network", args.network)
  query.set("currency-id", String(args.currencyId))

  return ibexGet<CryptoSendRequirements>(
    token,
    `/crypto/send/requirements?${query.toString()}`,
  )
}

const createCryptoSendInfo = async (
  body: CreateCryptoSendInfoBodyParam,
): Promise<CryptoSendInfo | IbexError> => {
  addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
  const token = await getIbexToken()
  if (token instanceof IbexError) return token

  return ibexPost<CryptoSendInfo>(token, "/crypto/send/infos", body)
}

const estimateOnchainFee = async (
  send: UsdWalletAmount,
  address: OnChainAddress,
): Promise<EstimateFeeCopyResponse200 | IbexError> => {
  return Ibex.estimateFeeV2({
    "amount": send.toIbex(),
    "currency-id": ibexCurrencyIdForUsdAmount(send).toString(),
    address,
  }).then(errorHandler)
}

const createLnurlPay = async (
  body: CreateLnurlPayBodyParam,
): Promise<CreateLnurlPayResponse201 | IbexError> => {
  if (mockIbexEnabled) {
    return { lnurl: mockLnurl } as CreateLnurlPayResponse201
  }

  const bodyWithHooks = {
    ...body,
    webhookUrl: ibexWebhookEndpoints.onReceive.lnurl,
    webhookSecret: ibexWebhookSecret,
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
    amount: args.amountMsat,
    params: args.params,
    webhookUrl: ibexWebhookEndpoints.onPay.lnurl,
    webhookSecret: ibexWebhookSecret,
  }).then(errorHandler)
}

const getIbexToken = async (): Promise<string | IbexError> => {
  const cached = await Ibex.authentication.storage.getAccessToken()
  if (typeof cached === "string") return `${cached}`

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: IbexConfig.clientId,
    client_secret: IbexConfig.clientSecret,
    audience: IbexUrlConfig.audience,
  })

  const resp = await fetch(`${IbexUrlConfig.authDomain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }).catch(
    (err: unknown) => new IbexError(err instanceof Error ? err : new Error(String(err))),
  )

  if (resp instanceof IbexError) return resp
  if (!resp.ok) {
    const responseBody = await resp.text().catch(() => "")
    return new IbexError(
      new Error(`IBEX token request failed: ${resp.status} — ${responseBody}`),
    )
  }

  const data = (await resp.json()) as {
    access_token?: string
    expires_in?: number
  }
  if (!data.access_token)
    return new IbexError(new Error("IBEX token request: no access_token in response"))

  await Ibex.authentication.storage.setAccessToken(data.access_token, data.expires_in)

  return data.access_token
}

const ibexFetch = async <T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T | IbexError> => {
  const url = `${IbexUrlConfig.hubUrl}${path}`
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

const createIbexAccount = async (
  name: string,
  currencyId: IbexCurrencyId,
): Promise<CreateAccountResponse201 | IbexError> => {
  try {
    const token = await getIbexToken()
    if (token instanceof IbexError) return token
    const data = await ibexPost<CreateAccountResponse201>(token, "/account/create", {
      name,
      currencyId,
    })
    if (data instanceof IbexError) return data
    return data
  } catch (err) {
    return new IbexError(err instanceof Error ? err : new Error(String(err)))
  }
}
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

const getCryptoReceiveOptions = async (): Promise<CryptoReceiveOption[] | IbexError> =>
  Ibex.getCryptoReceiveOptions().then(errorHandler)

const createCryptoReceiveInfo = async (
  accountId: IbexAccountId,
  option: CryptoReceiveOption,
): Promise<CryptoReceiveInfo | IbexError> => {
  return Ibex.createCryptoReceiveInfo(accountId, option).then(errorHandler)
}

const getTronUsdtOption = async (): Promise<CryptoReceiveOption | IbexError> => {
  const options = await getCryptoReceiveOptions()
  if (options instanceof IbexError) return options

  const tronUsdt = options.find(
    (opt) =>
      opt.currencyId === USDTAmount.currencyId && opt.network.toLowerCase() === "tron",
  )

  if (!tronUsdt) {
    return new IbexError(new Error("Tron USDT option not found"))
  }

  return tronUsdt
}

const findEthereumUsdtReceiveOption = (
  options: CryptoReceiveOption[],
): CryptoReceiveOption | IbexError => {
  const ethereumUsdt = options.find(
    (opt) =>
      opt.currencyId === USDTAmount.currencyId && opt.network.toLowerCase() === "ethereum",
  )

  if (!ethereumUsdt) {
    return new IbexError(new Error("Ethereum USDT option not found"))
  }

  return ethereumUsdt
}

const getEthereumUsdtOption = async (): Promise<CryptoReceiveOption | IbexError> => {
  const options = await getCryptoReceiveOptions()
  if (options instanceof IbexError) return options

  return findEthereumUsdtReceiveOption(options)
}

const getIbexCurrencyId = async (
  currency: WalletCurrency,
): Promise<IbexCurrencyId | IbexError> => {
  return (Ibex.getCurrencyId(currency) as Promise<IbexCurrencyId>).then(errorHandler)
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
    sendCrypto,
    getCryptoSendRequirements,
    createCryptoSendInfo,
    estimateOnchainFee,
    createLnurlPay,
    decodeLnurl,
    payToLnurl,
    createIbexAccount,
    getCryptoReceiveBalance,
    getCryptoReceiveOptions,
    createCryptoReceiveInfo,
    getTronUsdtOption,
    getEthereumUsdtOption,
    getIbexCurrencyId,
  },
})
