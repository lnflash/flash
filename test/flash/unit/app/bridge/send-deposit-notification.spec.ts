const config = { enabled: true }

jest.mock("@config", () => ({
  get BridgeConfig() {
    return config
  },
  getI18nInstance: jest.fn(),
}))

const findById = jest.fn()
jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: () => ({ findById }),
}))
jest.mock("@services/mongoose/users", () => ({
  UsersRepository: () => ({ findById: jest.fn() }),
}))
jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: jest.fn(),
}))
jest.mock("@services/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => logger),
  }
  return { baseLogger: logger }
})

import { sendBridgeDepositNotificationBestEffort } from "@app/bridge/send-deposit-notification"

describe("sendBridgeDepositNotificationBestEffort — bridge.enabled gate (ENG-466)", () => {
  afterEach(() => {
    config.enabled = true
    jest.clearAllMocks()
  })

  it("no-ops without touching the account repo when bridge is disabled", async () => {
    config.enabled = false
    await sendBridgeDepositNotificationBestEffort({
      accountId: "507f1f77bcf86cd799439011",
      amount: "10",
      currency: "USD",
    })
    expect(findById).not.toHaveBeenCalled()
  })

  it("proceeds (reaches the account lookup) when bridge is enabled", async () => {
    findById.mockResolvedValue(new Error("stop-after-lookup"))
    await sendBridgeDepositNotificationBestEffort({
      accountId: "507f1f77bcf86cd799439011",
      amount: "10",
      currency: "USD",
    })
    expect(findById).toHaveBeenCalled()
  })
})
