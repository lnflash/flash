const config = { enabled: true }

// Only BridgeConfig is faked. `getI18nInstance` is the REAL one so the content
// test below renders the shipped en.json phrase instead of asserting against a
// stub of itself.
jest.mock("@config", () => ({
  get BridgeConfig() {
    return config
  },
  getI18nInstance: (...a: unknown[]) =>
    jest.requireActual("@config").getI18nInstance(...a),
}))

const findById = jest.fn()
const findUserById = jest.fn()
const mockSendFiltered = jest.fn()
jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: () => ({ findById }),
}))
jest.mock("@services/mongoose/users", () => ({
  UsersRepository: () => ({ findById: (...a: unknown[]) => findUserById(...a) }),
}))
jest.mock("@services/notifications/push-notifications", () => ({
  PushNotificationsService: () => ({
    sendFilteredNotification: (...a: unknown[]) => mockSendFiltered(...a),
  }),
  SendFilteredPushNotificationStatus: { Sent: "Sent", Filtered: "Filtered" },
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

const ACCOUNT_ID = "507f1f77bcf86cd799439011"

beforeEach(() => {
  // Explicit defaults, not just clearAllMocks: `mockResolvedValue` survives
  // `clearAllMocks` (that only wipes calls), so a leftover implementation from
  // an earlier test would otherwise leak into this one.
  findById.mockResolvedValue({
    id: ACCOUNT_ID,
    kratosUserId: "kratos-1",
    notificationSettings: {},
  })
  findUserById.mockResolvedValue({ deviceTokens: ["tok-1"], language: "en" })
  mockSendFiltered.mockResolvedValue({ status: "Sent" })
})

describe("sendBridgeDepositNotificationBestEffort — bridge.enabled gate (ENG-466)", () => {
  afterEach(() => {
    config.enabled = true
    jest.clearAllMocks()
  })

  it("no-ops without touching the account repo when bridge is disabled", async () => {
    config.enabled = false
    await sendBridgeDepositNotificationBestEffort({
      accountId: ACCOUNT_ID,
      amount: "10",
      currency: "USD",
    })
    expect(findById).not.toHaveBeenCalled()
  })

  it("proceeds (reaches the account lookup) when bridge is enabled", async () => {
    findById.mockResolvedValue(new Error("stop-after-lookup"))
    await sendBridgeDepositNotificationBestEffort({
      accountId: ACCOUNT_ID,
      amount: "10",
      currency: "USD",
    })
    expect(findById).toHaveBeenCalled()
  })
})

describe("sendBridgeDepositNotificationBestEffort — payload content", () => {
  afterEach(() => {
    config.enabled = true
    jest.clearAllMocks()
  })

  // The push body, `data.type` and the usdt->USD mapping used to live in this
  // module; they now come from the shared `send-outcome-notification`, which
  // Fygaro (and whatever lands next) also drives. Without this test the only
  // Bridge assertion is "findById was called", so a change made to the shared
  // module's `data` merge or `amountArg` contract for a THIRD caller breaks
  // Bridge's live money-path push with a fully green Bridge suite.
  it("renders the deposit body and data payload the mobile app switches on", async () => {
    await sendBridgeDepositNotificationBestEffort({
      accountId: ACCOUNT_ID,
      amount: "10",
      currency: "usdt",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.title).toBe("Deposit received")
    expect(args.body).toContain("10 USDT")
    // `usdt` is the on-chain asset; the app shows the wallet currency. Major
    // units under `amount`, matching every other Payments push.
    expect(args.data).toEqual({
      type: "bridge_deposit_completed",
      amount: "10",
      currency: "USD",
    })
  })

  it("routes non-default outcomes to their own phrase and type", async () => {
    // `outcome` defaults to "completed"; the other two are real Bridge states,
    // and each must keep its own i18n key + `data.type` through the shared path.
    await sendBridgeDepositNotificationBestEffort({
      accountId: ACCOUNT_ID,
      amount: "25.50",
      currency: "usd",
      outcome: "processing",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.title).toBe("Deposit processing")
    expect(args.body).toContain("25.50 USD")
    expect(args.data).toEqual({
      type: "bridge_deposit_processing",
      amount: "25.50",
      currency: "USD",
    })
  })
})
