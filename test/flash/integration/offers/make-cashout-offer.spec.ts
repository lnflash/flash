import OffersManager from "@app/offers/OffersManager"
import { alice } from "../jest.setup"
import OffersRepository from "@app/offers/storage/Redis"
import { RepositoryError } from "@domain/errors"
// import { mockedIbex } from "../jest.setup"
import * as Mocks from "test/flash/mocks/ibex"
import Ibex from "@services/ibex/client"

const send = {
  amount: 101n,
  currency: "USD"
} as Amount<"USD">

jest.mock(
  "@services/ibex/client",
  // () => require("test/flash/mocks/ibex"),
)
let mockedIbex: jest.Mock
beforeAll(async () => {
  // Mocking the http call would be more useful, but adds complexity to tests
  mockedIbex = Ibex as jest.Mock // move to beforeAll

  //  await Ibex().getAccountDetails({ accountId: walletId })
  // mockedIbex.mockReset()

  // jest.spyOn(mockedIbex, 'getAccountDetails').mockImplementation(() => {
  // });
})

beforeEach(async () => {
  const getAccountDetailsMock = jest.fn().mockResolvedValue(
    Mocks.account.response // override the balance
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
    const offer = await (new OffersManager().makeCashoutOffer(alice.usdWalletD.id, send))
   
    if (offer instanceof Error) throw offer
    expect(offer.ibexTransfer.amount).toEqual(send.amount)
    expect(offer.flashFee.amount).toEqual(2n)
    expect(offer.flashFee.currency).toEqual("USD")
    expect(offer.usdLiability.amount).toEqual(99n)
    expect(offer.usdLiability.currency).toEqual("USD")
    expect(offer.jmdLiability.amount).toEqual(157n)
    expect(offer.jmdLiability.currency).toEqual("JMD")
  })
})