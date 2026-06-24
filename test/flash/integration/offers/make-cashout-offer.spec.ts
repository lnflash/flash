import CashoutManager from "@app/offers/CashoutManager"

// import { mockedIbex } from "../jest.setup"
import Ibex from "@services/ibex/client"
import { USDAmount } from "@domain/shared"

import { alice } from "../jest.setup"

import * as Mocks from "test/flash/mocks/ibex"

const send = USDAmount.cents("101") as USDAmount

jest.mock("@services/ibex/client", () => ({
  getAccountDetails: jest.fn(),
  addInvoice: jest.fn(),
  createAccount: jest.fn(),
}))
let mockedIbex: jest.Mocked<typeof Ibex>
beforeAll(async () => {
  // Mocking the http call would be more useful, but adds complexity to tests
  mockedIbex = Ibex as jest.Mocked<typeof Ibex> // move to beforeAll
})

beforeEach(async () => {
  const getAccountDetailsMock = jest.fn().mockResolvedValue(
    Mocks.account.response, // override the balance
  )
  mockedIbex.getAccountDetails.mockImplementation(getAccountDetailsMock)
  mockedIbex.addInvoice.mockResolvedValue(Mocks.addInvoice.response)
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
    expect(offer.details.payout.amount.asCents()).toEqual("157")
    expect(offer.details.payout.amount.currencyCode).toEqual("JMD")
    expect(offer.details.payout.exchangeRate?.asCents()).toEqual("15500")
  })
})
