import { client as Ibex } from "@services/ibex"

import { AccountsRepository } from "@services/mongoose"

import { toSats } from "@domain/bitcoin"
import { PayoutSpeed } from "@domain/bitcoin/onchain"
import { Wallets } from "@app/index"

import Mocks from "test/mocks"
import { createMandatoryUsers, createRandomUserAndWallets } from "test/helpers"
const amount = toSats(10040)
let outsideAddress: OnChainAddress
// eslint-disable-next-line prefer-const
outsideAddress = "bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw" as OnChainAddress

let memo
const randomOnChainMemo = () =>
  "this is my onchain memo #" + (Math.random() * 1_000_000).toFixed()

jest.mock("@services/ibex")

type User = {
  account: Account
  usdWalletD: WalletDescriptor<"USD">
}
let alice: User

beforeAll(async () => {
  // Create users
  await createMandatoryUsers()
  const { usdWalletDescriptor } = await createRandomUserAndWallets()
  const account = await AccountsRepository().findById(usdWalletDescriptor.accountId)
  if (account instanceof Error) throw account
  alice = {
    account,
    usdWalletD: usdWalletDescriptor,
  }
})

beforeEach(async () => {
  memo = randomOnChainMemo()
})

afterEach(async () => {
  jest.clearAllMocks() // replaces fn.mock.calls and fn.mock.instances
  //   await Transaction.deleteMany()
  //   await TransactionMetadata.deleteMany()
})

describe("Wallet.payOnChainByWalletIdForUsdWallet", () => {
  it("gets a 200 (INITIATED) response from Ibex", async () => {
    const { response } = Mocks.ibex.SendToAddressV2
    const mockedIbex = Ibex as jest.Mock // move to beforeAll
    // TODO: mock the http call rather than the sdk
    mockedIbex.mockReturnValue({
      sendToAddressV2: jest.fn().mockResolvedValue(response),
    })

    const output = await Wallets.payOnChainByWalletIdForUsdWallet({
      senderAccount: alice.account,
      senderWalletId: alice.usdWalletD.id,
      amount: amount,
      address: outsideAddress,
      speed: PayoutSpeed.Fast, // unused by Ibex
      memo, // unused by Ibex
    })
    if (output instanceof Error) throw output

    expect(output).toEqual({ status: { value: "pending" }, payoutId: "abcd-1234" })
  })
})
