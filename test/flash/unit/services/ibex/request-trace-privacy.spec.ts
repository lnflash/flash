// All credentials and values are deterministic public fixtures. No SDK call,
// network request, span export, cache, or private environment is used.
jest.mock("@config", () => ({
  IbexConfig: {
    environment: "sandbox",
    mock: false,
    clientId: "fixture-client",
    clientSecret: "fixture-client-secret",
    webhook: { uri: "https://fixture.invalid/ibex", secret: "fixture-webhook-secret" },
  },
}))
jest.mock("@services/ibex/cache", () => ({ Redis: {} }))
jest.mock("@services/logger", () => ({ baseLogger: { error: jest.fn() } }))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
  // The real central wrapper's input privacy is verified separately by the
  // tracing-input-privacy suite. Here capture this adapter's explicit writes.
  wrapAsyncFunctionsToRunInSpan: jest.fn(({ fns }) => fns),
}))
jest.mock("ibex-client", () => {
  const fixture = {
    authentication: { storage: { getAccessToken: jest.fn() } },
    getAccountTransactions: jest.fn(),
    addInvoice: jest.fn(),
    payInvoiceV2: jest.fn(),
    sendToAddressV2: jest.fn(),
    createLnurlPay: jest.fn(),
  }
  return {
    ...jest.requireActual("ibex-client"),
    __esModule: true,
    fixture,
    default: jest.fn(() => fixture),
    IbexUrls: {
      sandbox: {
        authDomain: "https://fixture-auth.invalid",
        audience: "fixture-audience",
        hubUrl: "https://fixture-api.invalid",
      },
    },
  }
})

import Ibex from "@services/ibex/client"
import { USDAmount, USDTAmount } from "@domain/shared"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

const sdk = jest.requireMock("ibex-client").fixture
const providerResult = { fixtureResult: true }
let fetch: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  for (const name of [
    "getAccountTransactions",
    "addInvoice",
    "payInvoiceV2",
    "sendToAddressV2",
    "createLnurlPay",
  ]) {
    sdk[name].mockResolvedValue(providerResult)
  }
  sdk.authentication.storage.getAccessToken.mockResolvedValue(
    "fixture-provider-access-token",
  )
  fetch = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(providerResult), { status: 200 }))
})
afterEach(() => fetch.mockRestore())

const expectNoInputTelemetry = () => {
  expect(addAttributesToCurrentSpan).not.toHaveBeenCalled()
  expect(recordExceptionInCurrentSpan).not.toHaveBeenCalled()
}

it("sends the exact receive body and authentication secret to IBEX without tracing its account, memo or secret", async () => {
  const amount = USDAmount.cents(125n)
  expect(amount).not.toBeInstanceOf(Error)
  const result = await Ibex.addInvoice({
    accountId: "fixture-account" as IbexAccountId,
    amount: amount as USDAmount,
    memo: "Private name and purchase memo",
    expiration: 300 as Seconds,
  })
  expect(result).toBe(providerResult)
  expect(sdk.addInvoice).toHaveBeenCalledWith({
    accountId: "fixture-account",
    amount: 1.25,
    memo: "Private name and purchase memo",
    expiration: 60,
    webhookUrl: "https://fixture.invalid/ibex/receive/invoice",
    webhookSecret: "fixture-webhook-secret",
  })
  expectNoInputTelemetry()
})

it("keeps the Lightning invoice, account, amount and required payment webhook secret only in the provider call", async () => {
  const amount = USDTAmount.smallestUnits(1250000n)
  expect(amount).not.toBeInstanceOf(Error)
  const result = await Ibex.payInvoice({
    accountId: "fixture-account" as IbexAccountId,
    invoice: "fixture-private-bolt11" as Bolt11,
    send: amount as USDTAmount,
  })
  expect(result).toBe(providerResult)
  expect(sdk.payInvoiceV2).toHaveBeenCalledWith({
    accountId: "fixture-account",
    bolt11: "fixture-private-bolt11",
    amount: 1.25,
    webhookUrl: "https://fixture.invalid/ibex/pay/invoice",
    webhookSecret: "fixture-webhook-secret",
  })
  expectNoInputTelemetry()
})

it("keeps the onchain destination and secret in the unchanged provider body rather than a request.params span", async () => {
  const input = {
    accountId: "fixture-account",
    address: "fixture-private-destination",
    amount: 125,
  }
  const original = { ...input }
  expect(await Ibex.sendOnchain(input)).toBe(providerResult)
  expect(input).toEqual(original)
  expect(sdk.sendToAddressV2).toHaveBeenCalledWith({
    ...input,
    webhookUrl: "https://fixture.invalid/ibex/pay/onchain",
    webhookSecret: "fixture-webhook-secret",
  })
  expectNoInputTelemetry()
})

it("preserves the static LNURL provider request and required secret without tracing its contents", async () => {
  const input = { accountId: "fixture-account", currencyId: 29, amount: 1.25 }
  expect(await Ibex.createLnurlPay(input)).toBe(providerResult)
  expect(sdk.createLnurlPay).toHaveBeenCalledWith({
    ...input,
    webhookUrl: "https://fixture.invalid/ibex/receive/lnurlp",
    webhookSecret: "fixture-webhook-secret",
  })
  expectNoInputTelemetry()
})

it("preserves transaction history query parameters without tracing account identifiers", async () => {
  const input = { account_id: "fixture-private-account", limit: 10, page: 2 }
  expect(await Ibex.getAccountTransactions(input)).toBe(providerResult)
  expect(sdk.getAccountTransactions).toHaveBeenCalledWith(input)
  expectNoInputTelemetry()
})

it("preserves the crypto-send authenticated request without tracing account or destination handles", async () => {
  const input = {
    accountId: "fixture-private-account",
    cryptoSendInfosId: "fixture-private-destination-handle",
    amount: 1.25,
  }
  expect(await Ibex.sendCrypto(input)).toEqual(providerResult)
  expect(fetch).toHaveBeenCalledWith(
    "https://fixture-api.invalid/accounts/fixture-private-account/crypto/send",
    {
      method: "POST",
      headers: {
        "Authorization": "fixture-provider-access-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cryptoSendInfosId: input.cryptoSendInfosId, amount: 1.25 }),
    },
  )
  expectNoInputTelemetry()
})

it("preserves crypto requirement query units without serializing a trace payload", async () => {
  expect(
    await Ibex.getCryptoSendRequirements({
      network: "ethereum",
      currencyId: USDTAmount.currencyId,
    }),
  ).toEqual(providerResult)
  expect(fetch).toHaveBeenCalledWith(
    "https://fixture-api.invalid/crypto/send/requirements?network=ethereum&currency-id=29",
    {
      method: "GET",
      headers: {
        "Authorization": "fixture-provider-access-token",
        "Content-Type": "application/json",
      },
    },
  )
  expectNoInputTelemetry()
})

it("preserves crypto destination name/address metadata for IBEX without recording banking/identity details in spans", async () => {
  const input = {
    name: "Private person withdrawal",
    requirementsId: "fixture-requirement",
    data: {
      address: "fixture-private-wallet-address",
      fullName: "Private Name",
      accountNumber: "fixture-private-bank-account",
    },
  }
  expect(await Ibex.createCryptoSendInfo(input)).toEqual(providerResult)
  expect(fetch).toHaveBeenCalledWith("https://fixture-api.invalid/crypto/send/infos", {
    method: "POST",
    headers: {
      "Authorization": "fixture-provider-access-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  })
  expectNoInputTelemetry()
})
