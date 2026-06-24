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
import { setupMongoConnection } from "@services/mongodb"
import { disconnectAll } from "@services/redis"

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
  getAccountDetails: jest.fn(),
}))
export let mockedIbex: jest.Mock

beforeAll(async () => {
  mockedIbex = Ibex as unknown as jest.Mock
  mockedIbexClient = Ibex as jest.Mocked<typeof Ibex>
  mockedIbexClient.createAccount.mockResolvedValue(IbexMocks.account.response[0])
  mockedIbexClient.addInvoice.mockResolvedValue(IbexMocks.addInvoice.response)

  mongoose = await setupMongoConnection(true)
  const admins = await createMandatoryUsers()
  const owner = admins.find((a) => a.role === "bankowner")
  if (!owner) throw new Error("Initialization failed: Bank owner not found.")
  flash = {
    account: await getAccountByPhone(owner.phone),
    usdWalletD: await getUsdWalletDescriptorByPhone(owner.phone),
  }
  alice = await createUser()
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
