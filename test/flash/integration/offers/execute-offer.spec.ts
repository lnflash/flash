import CashoutManager from "@app/offers/CashoutManager"

import { JMDAmount, USDAmount } from "@domain/shared"
import ErpNext, { CashoutId } from "@services/frappe/ErpNext"
import Ibex from "@services/ibex/client"

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
  payInvoice: jest.fn(),
}))
jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getBankAccountsByCustomer: jest.fn(),
    getCashoutExchangeRate: jest.fn(),
    draftCashout: jest.fn(),
    submitCashout: jest.fn(),
  },
}))
jest.mock("@services/email", () => ({
  EmailService: {
    sendCashoutInitiatedEmail: jest.fn(),
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
    lnurl: "lnurl1dp68gurn8ghj7um9dej8xct5v93kzmmfd3skjmn0wvhxcmmv9u",
  })
  mockedIbex.payInvoice.mockResolvedValue(Mocks.payInvoiceV2.response)
  mockedErpNext.getBankAccountsByCustomer.mockResolvedValue([bankAccount])
  mockedErpNext.getCashoutExchangeRate.mockResolvedValue(
    JMDAmount.dollars(160) as JMDAmount,
  )
  mockedErpNext.draftCashout.mockResolvedValue("cashout-test-id" as CashoutId)
  mockedErpNext.submitCashout.mockResolvedValue(true)
})

afterEach(async () => {
  jest.clearAllMocks()
})

describe("Offers", () => {
  it("successfully makes and executes an offer", async () => {
    const offer = await CashoutManager.createOffer(alice.usdWalletD.id, send, "")
    if (offer instanceof Error) throw offer

    const { id } = offer
    const status = await CashoutManager.executeCashout(id, alice.usdWalletD.id)

    // make assertions against ledger
    expect(status).toBeDefined()
  })
})
