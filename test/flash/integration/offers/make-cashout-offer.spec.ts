import CashoutManager from "@app/offers/CashoutManager"

// import { mockedIbex } from "../jest.setup"
import Ibex from "@services/ibex/client"
import { USDAmount } from "@domain/shared"

import { alice } from "../jest.setup"

import * as Mocks from "test/flash/mocks/ibex"

const send = USDAmount.cents("101") as USDAmount

jest.mock(
  "@services/ibex/client",
  // () => require("test/flash/mocks/ibex"),
)
let mockedIbex: jest.Mock
beforeAll(async () => {
  // Mocking the http call would be more useful, but adds complexity to tests
  mockedIbex = Ibex as unknown as jest.Mock // move to beforeAll

  //  await Ibex().getAccountDetails({ accountId: walletId })
  // mockedIbex.mockReset()

  // jest.spyOn(mockedIbex, 'getAccountDetails').mockImplementation(() => {
  // });
})

beforeEach(async () => {
  const getAccountDetailsMock = jest.fn().mockResolvedValue(
    Mocks.account.response, // override the balance
  )
  mockedIbex.mockReturnValue({
    getAccountDetails: getAccountDetailsMock,
  })
})

afterEach(async () => {
  jest.clearAllMocks()
})

describe("Offers", () => {
  it("successfully makes and persists an offer using default config", async () => {
    const offer = await (new CashoutManager().makeCashoutOffer(alice.usdWalletD.id, send))

    if (offer instanceof Error) throw offer
    expect(offer.details.ibexTrx.usd.asCents()).toEqual(send.asCents())
    expect(offer.details.flash.fee.asCents()).toEqual("2")
    expect(offer.details.flash.fee.currencyCode).toEqual("USD")
    expect(offer.details.flash.liability.usd.asCents()).toEqual("99")
    expect(offer.details.flash.liability.usd.currencyCode).toEqual("USD")
    expect(offer.details.flash.liability.jmd.asCents()).toEqual("157")
    expect(offer.details.flash.liability.jmd.currencyCode).toEqual("JMD")
  })
})
