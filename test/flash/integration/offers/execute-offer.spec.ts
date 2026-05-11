import OffersManager from "@app/offers/OffersManager"

// import { mockedIbex } from "../jest.setup"
import { USDAmount } from "@domain/shared"

import { alice } from "../jest.setup"

const send = USDAmount.cents("100") as USDAmount

// jest.mock(
//   "@services/ibex/client",
//   // () => require("test/flash/mocks/ibex"),
// )
// let mockedIbex: jest.Mock
beforeAll(async () => {
  // Mocking the http call would be more useful, but adds complexity to tests
  // mockedIbex = Ibex as unknown as jest.Mock // move to beforeAll
  //  await Ibex().getAccountDetails({ accountId: walletId })
  // mockedIbex.mockReset()
  // jest.spyOn(mockedIbex, 'getAccountDetails').mockImplementation(() => {
  // });
})

beforeEach(async () => {
  // const getAccountDetailsMock = jest.fn().mockResolvedValue(
  //   Mocks.account.response // override the balance
  // )
  // mockedIbex.mockReturnValue({
  //   getAccountDetails: getAccountDetailsMock,
  // })
})

afterEach(async () => {
  jest.clearAllMocks()
})

describe("Offers", () => {
  it("successfully makes and executes an offer", async () => {
    const offer = await OffersManager.createCashoutOffer(alice.usdWalletD.id, send)
    if (offer instanceof Error) throw offer

    const { id } = offer
    const status = await OffersManager.executeCashout(id, alice.usdWalletD.id)

    // make assertions against ledger
    expect(status).toBeDefined()
  })
})
