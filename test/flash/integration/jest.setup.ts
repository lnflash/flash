import { disconnectAll } from "@services/redis"
import { setupMongoConnection } from "@services/mongodb"
import { createMandatoryUsers, createRandomUserAndWallets, createUser, getUser, createUserAndWallet, TestUser, getUsdWalletDescriptorByPhone, getAccountByPhone } from "test/galoy/helpers"

let mongoose
export let flash: TestUser
export let alice: TestUser
export let bob: TestUser

// Mock prices
jest.mock(
  "@app/prices/get-current-price",
  () => require("test/flash/mocks/get-current-price"),
)

beforeAll(async () => {
  mongoose = await setupMongoConnection(true)
  const admins = await createMandatoryUsers()
  const owner = admins.find(a => a.role === "bankowner")
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
