import { DeviceTokensNotRegisteredNotificationsServiceError } from "@domain/notifications"

const mockFindAccountById = jest.fn()
const mockFindUserById = jest.fn()
const mockSendFiltered = jest.fn()
const mockRemoveDeviceTokens = jest.fn()

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: () => ({
    findById: (...a: unknown[]) => mockFindAccountById(...a),
  }),
}))
jest.mock("@services/mongoose/users", () => ({
  UsersRepository: () => ({ findById: (...a: unknown[]) => mockFindUserById(...a) }),
}))
jest.mock("@services/notifications/push-notifications", () => ({
  PushNotificationsService: () => ({
    sendFilteredNotification: (...a: unknown[]) => mockSendFiltered(...a),
  }),
  SendFilteredPushNotificationStatus: { Sent: "Sent", Filtered: "Filtered" },
}))
jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: (...a: unknown[]) => mockRemoveDeviceTokens(...a),
}))

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  sendFygaroTopupNotification,
  sendFygaroTopupNotificationBestEffort,
} = require("@app/fygaro/send-topup-notification")
/* eslint-enable @typescript-eslint/no-var-requires */

const ACCOUNT_ID = "6a8203ce490716aa69381454"

beforeEach(() => {
  jest.clearAllMocks()
  mockFindAccountById.mockResolvedValue({
    id: ACCOUNT_ID,
    kratosUserId: "kratos-1",
    notificationSettings: {},
  })
  mockFindUserById.mockResolvedValue({ deviceTokens: ["tok-1"], language: "en" })
  mockSendFiltered.mockResolvedValue({ status: "Sent" })
})

describe("sendFygaroTopupNotification", () => {
  it("tells the customer the NET that landed, not the gross they paid", async () => {
    // $60 paid, $56.52 credited. Naming the gross would overstate the balance
    // change and invite a support ticket about the missing $3.48.
    await sendFygaroTopupNotification({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.body).toContain("$56.52")
    expect(args.data).toMatchObject({ type: "fygaro_topup_credited", currency: "USD" })
  })

  it("also notifies when the payment was captured and NOT credited", async () => {
    // The case that actually matters. Notifying only on success keeps the
    // promise exactly when it costs nothing.
    await sendFygaroTopupNotification({
      accountId: ACCOUNT_ID,
      outcome: "heldForReview",
      amountCents: 6000,
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.body).toContain("$60.00")
    expect(args.data).toMatchObject({ type: "fygaro_topup_heldForReview" })
    // Not a dead end: ops is already paged by the gate that produced this.
    expect(args.body.toLowerCase()).toContain("completing it manually")
  })

  it("sends in the user's language", async () => {
    mockFindUserById.mockResolvedValue({ deviceTokens: ["tok-1"], language: "es" })

    await sendFygaroTopupNotification({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
    })

    expect(mockSendFiltered.mock.calls[0][0].title).toBe("Recarga completada")
  })

  it("returns the error rather than throwing when the account cannot be read", async () => {
    mockFindAccountById.mockResolvedValue(new Error("mongo down"))

    const res = await sendFygaroTopupNotification({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
    })

    expect(res).toBeInstanceOf(Error)
    expect(mockSendFiltered).not.toHaveBeenCalled()
  })
})

describe("sendFygaroTopupNotificationBestEffort", () => {
  it("never throws when the push fails — the money has already moved", async () => {
    // Turning a failed notification into an error would put a DELIVERED credit
    // back into Fygaro's retry loop.
    mockSendFiltered.mockResolvedValue(new Error("fcm unavailable"))

    await expect(
      sendFygaroTopupNotificationBestEffort({
        accountId: ACCOUNT_ID,
        outcome: "credited",
        amountCents: 5652,
      }),
    ).resolves.toBeUndefined()
  })

  it("prunes device tokens that are no longer registered", async () => {
    // Reinstalled or handed-on devices, so the next notification is not sent
    // into the same void.
    mockSendFiltered.mockResolvedValue(
      new DeviceTokensNotRegisteredNotificationsServiceError(["stale-1" as DeviceToken]),
    )

    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
    })

    expect(mockRemoveDeviceTokens).toHaveBeenCalledWith({
      userId: "kratos-1",
      deviceTokens: ["stale-1"],
    })
  })

  it("swallows an unreadable account without throwing", async () => {
    mockFindAccountById.mockResolvedValue(new Error("mongo down"))

    await expect(
      sendFygaroTopupNotificationBestEffort({
        accountId: ACCOUNT_ID,
        outcome: "heldForReview",
        amountCents: 6000,
      }),
    ).resolves.toBeUndefined()
  })
})
