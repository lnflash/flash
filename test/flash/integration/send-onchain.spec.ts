import Ibex from "@services/ibex/client"

import { AccountsRepository } from "@services/mongoose"

import { PayoutSpeed } from "@domain/bitcoin/onchain"
import { Wallets } from "@app/index"

import Mocks from "test/flash/mocks"
import { createMandatoryUsers, createRandomUserAndWallets, createUser, createUserAndWallet, TestUser } from "test/galoy/helpers"
import { ValidationError } from "@domain/shared"

const randomOnChainMemo = () =>
  "this is my onchain memo #" + (Math.random() * 1_000_000).toFixed()

jest.mock("@services/ibex/client")

let alice: TestUser
let bob: TestUser
const memo = randomOnChainMemo()
const regtestAddr = "bcrt1q6z64a43mjgkcq0ul2zaqusq3spghrlau9slefp" // taken from unit tests

let mockedIbex: jest.Mock
beforeAll(async () => {
  await createMandatoryUsers()
  alice = await createUser()
  bob = await createUser()

  // Mocking the http call would be more useful, but adds complexity to tests
  mockedIbex = Ibex as jest.Mock // move to beforeAll
})

beforeEach(async () => {
  /* do nothing */
})

afterEach(async () => {
  jest.clearAllMocks() // replaces fn.mock.calls and fn.mock.instances
  //   await Transaction.deleteMany()
  //   await TransactionMetadata.deleteMany()
})

describe("Wallet.payOnChainByWalletIdForUsdWallet", () => {
  it("successfully handles 200 (INITIATED) response from Ibex", async () => {
    // eslint-disable-next-line prettier/prettier
    const sendToAddressV2Mock = jest.fn().mockResolvedValue(
      Mocks.ibex.SendToAddressV2.response
    )
    mockedIbex.mockReturnValue({
      sendToAddressV2: sendToAddressV2Mock,
    })

    const output = await Wallets.payOnChainByWalletIdForUsdWallet({
      senderAccount: alice.account,
      senderWalletId: alice.usdWalletD.id,
      amount: 5000, // FractionalCentAmount
      address: regtestAddr,
      speed: PayoutSpeed.Fast, // unused by Ibex
      memo, // unused by Ibex
    })
    if (output instanceof Error) throw output

    expect(sendToAddressV2Mock).toHaveBeenCalledWith({
      accountId: alice.usdWalletD.id, // Flash walletId is Ibex accountId
      amount: 50, // in dollars
      address: regtestAddr,
    })
    expect(output).toEqual({ status: { value: "pending" }, payoutId: "abcd-1234" })
  })

  // Add unit tests for types of PaymentInputValidation failures
  it("throws error when PaymentInputValidation", async () => {
    // Note: sender wallet does not belong to account
    const output = await Wallets.payOnChainByWalletIdForUsdWallet({
      senderAccount: alice.account,
      senderWalletId: bob.usdWalletD.id,
      amount: 5000,
      address: regtestAddr,
      speed: PayoutSpeed.Fast, // unused by Ibex
      memo, // unused by Ibex
    })
    expect(output).toBeInstanceOf(ValidationError)
  })
})
