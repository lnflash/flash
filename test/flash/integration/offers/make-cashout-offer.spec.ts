import CashoutManager from "@app/offers/CashoutManager"

import ErpNext from "@services/frappe/ErpNext"
import Ibex from "@services/ibex/client"
import { USDAmount } from "@domain/shared"

import { alice } from "../jest.setup"

import * as Mocks from "test/flash/mocks/ibex"

jest.mock("@domain/bitcoin/lightning", () => {
  const actual = jest.requireActual("@domain/bitcoin/lightning")
  return {
    ...actual,
    decodeInvoice: jest.fn(() => ({
      destination: "0".repeat(66) as Pubkey,
      paymentHash:
        "8862fa7f4dcea0533952783bda143ff7fb7242a9573ac74f1ff944a601f02319" as PaymentHash,
      paymentRequest: "lnbc1test" as EncodedPaymentRequest,
      milliSatsAmount: 0 as MilliSatoshis,
      description: "",
      cltvDelta: null,
      amount: null,
      paymentAmount: null,
      routeHints: [],
      paymentSecret: null,
      features: [],
      expiresAt: new Date(Date.now() + 600_000),
      isExpired: false,
    })),
  }
})
jest.mock("@services/email", () => ({
  EmailService: {
    sendCashoutInitiatedEmail: jest.fn(),
  },
}))

const send = USDAmount.cents("100") as USDAmount
const bankAccount = {
  name: "",
  account_name: "Test Account",
  bank: "Test Bank",
  bank_account_no: "000000000",
  branch_code: "000",
  account_type: "Checking",
  currency: "JMD",
}

jest.mock("@services/ibex/client", () => ({
  getAccountDetails: jest.fn(),
  addInvoice: jest.fn(),
  createLnurlPay: jest.fn(),
  createAccount: jest.fn(),
}))
jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getBankAccountsByCustomer: jest.fn(),
  },
}))
let mockedIbex: jest.Mocked<typeof Ibex>
let mockedErpNext: jest.Mocked<typeof ErpNext>
beforeAll(async () => {
  mockedIbex = Ibex as jest.Mocked<typeof Ibex>
  mockedErpNext = ErpNext as jest.Mocked<typeof ErpNext>
})

beforeEach(async () => {
  mockedIbex.addInvoice.mockResolvedValue(Mocks.addInvoice.response)
  mockedIbex.createLnurlPay.mockResolvedValue({
    lnurl:
      "lnurl1dp68gurn8ghj7um9dej8xct5w3skccne9e3k7mf0d3h82unvwqhkxun0wa5kgct5v93kzmmfd3skjmn0wvhxcmmv9u",
  })
  mockedErpNext.getBankAccountsByCustomer.mockResolvedValue([bankAccount])
})

afterEach(async () => {
  jest.clearAllMocks()
})

describe("Offers", () => {
  it("successfully makes and persists an offer using default config", async () => {
    const offer = await CashoutManager.createOffer(alice.usdWalletD.id, send, "")

    if (offer instanceof Error) throw offer
    expect(offer.details.payment.amount.currencyCode).toMatch(/^USD/)
    expect(offer.details.payout.serviceFee.asCents()).toEqual("2")
    expect(offer.details.payout.serviceFee.currencyCode).toEqual("USD")
    expect(offer.details.payout.amount.asCents()).toEqual("15680")
    expect(offer.details.payout.amount.currencyCode).toEqual("JMD")
    expect(offer.details.payout.exchangeRate?.asCents()).toEqual("16000")
  })
})
