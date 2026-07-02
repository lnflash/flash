jest.mock("yargs", () => {
  const yargsMock = {
    option: jest.fn().mockReturnThis(),
    argv: {
      configPath: ["./dev/config/base-config.yaml"],
    },
  }
  return jest.fn(() => yargsMock)
})

import Ibex from "@services/ibex/client"
import { AccountLevel } from "@domain/accounts"
import { USDAmount } from "@domain/shared"
import { setupMongoConnection } from "@services/mongodb"
import { AccountsRepository } from "@services/mongoose"
import { disconnectAll } from "@services/redis"
import { IbexAccountDetails } from "@services/ibex/types"

import {
  createMandatoryUsers,
  createUser,
  getUsdWalletDescriptorByPhone,
  getAccountByPhone,
} from "test/galoy/helpers"

let mongoose
export let flash // : TestUser
export let alice // : TestUser
export let bob //: TestUser
let mockedIbexClient: jest.Mocked<typeof Ibex>

// Mock prices
jest.mock("@app/prices/get-current-price", () =>
  require("test/flash/mocks/get-current-price"),
)

import * as IbexMocks from "test/flash/mocks/ibex"
jest.mock("@services/ibex/client", () => ({
  createAccount: jest.fn(),
  addInvoice: jest.fn(),
  createLnurlPay: jest.fn(),
  getAccountDetails: jest.fn(),
  payInvoice: jest.fn(),
}))
export let mockedIbex: jest.Mock

beforeAll(async () => {
  mockedIbex = Ibex as unknown as jest.Mock
  mockedIbexClient = Ibex as jest.Mocked<typeof Ibex>
  const accountBalance = USDAmount.dollars("21000")
  if (accountBalance instanceof Error) throw accountBalance
  const accountDetails: IbexAccountDetails = {
    ...IbexMocks.account.response[0],
    balance: accountBalance,
  }
  mockedIbexClient.createAccount.mockImplementation(async (accountId, currencyId) => ({
    ...IbexMocks.account.response[0],
    id: `${accountId}-${currencyId}`,
    name: `${accountId}-${currencyId}`,
    currencyId,
  }))
  mockedIbexClient.getAccountDetails.mockResolvedValue(accountDetails)
  mockedIbexClient.addInvoice.mockResolvedValue(IbexMocks.addInvoice.response)
  mockedIbexClient.payInvoice.mockResolvedValue(IbexMocks.payInvoiceV2.response)
  mockedIbexClient.createLnurlPay.mockResolvedValue({
    lnurl:
      "lnurl1dp68gurn8ghj7um9dej8xct5w3skccne9e3k7mf0d3h82unvwqhkxun0wa5kgct5v93kzmmfd3skjmn0wvhxcmmv9u",
  })

  mongoose = await setupMongoConnection(true)
  const admins = await createMandatoryUsers()
  const owner = admins.find((a) => a.role === "bankowner")
  if (!owner) throw new Error("Initialization failed: Bank owner not found.")
  flash = {
    account: await getAccountByPhone(owner.phone),
    usdWalletD: await getUsdWalletDescriptorByPhone(owner.phone),
  }
  alice = await createUser()
  const upgradedAliceAccount = await AccountsRepository().update({
    ...alice.account,
    level: AccountLevel.Two,
  })
  if (upgradedAliceAccount instanceof Error) throw upgradedAliceAccount
  alice.account = upgradedAliceAccount
  bob = await createUser()
})

// Would be nice to clean-up Ibex accounts, but Ibex API does not have delete
afterAll(async () => {
  // avoids to use --forceExit
  disconnectAll()
  if (mongoose) {
    await mongoose.connection.close()
  }
})

jest.setTimeout(Number(process.env.JEST_TIMEOUT) || 30000)
