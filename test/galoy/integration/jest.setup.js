import { disconnectAll } from "@services/redis"
import { setupMongoConnection } from "@services/mongodb"

let mongoose

// Mock prices
jest.mock("@app/prices/get-current-price", () => require("test/mocks/get-current-price"))

beforeAll(async () => {
  mongoose = await setupMongoConnection(true)
})

afterAll(async () => {
  // avoids to use --forceExit
  disconnectAll()
  if (mongoose) {
    await mongoose.connection.close()
  }
})

jest.setTimeout(process.env.JEST_TIMEOUT || 30000)
