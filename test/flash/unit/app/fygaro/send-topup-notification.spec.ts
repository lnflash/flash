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

import {
  sendFygaroTopupNotification,
  sendFygaroTopupNotificationBestEffort,
} from "@app/fygaro/send-topup-notification"

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
      currency: "USD",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.body).toContain("56.52 USD")
    expect(args.data).toMatchObject({ type: "fygaro_topup_credited", currency: "USD" })
  })

  it("sends data.amount in MAJOR units, the way every other Payments push does", async () => {
    // `amount` is the Bridge-deposit convention (major units); the referral
    // sender uses a different key, `amountCents`, precisely because it is cents.
    // Cents under this key renders a $56.52 credit as $5,652 in the app.
    await sendFygaroTopupNotification({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
      currency: "USD",
    })

    expect(mockSendFiltered.mock.calls[0][0].data.amount).toBe("56.52")
  })

  it("also notifies when the payment was captured and NOT credited", async () => {
    // The case that actually matters. Notifying only on success keeps the
    // promise exactly when it costs nothing.
    await sendFygaroTopupNotification({
      accountId: ACCOUNT_ID,
      outcome: "heldForReview",
      amountCents: 6000,
      currency: "USD",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.body).toContain("60.00 USD")
    expect(args.data).toMatchObject({ type: "fygaro_topup_heldForReview" })
    // Not a dead end: ops is already paged by the gate that produced this.
    expect(args.body.toLowerCase()).toContain("completing it manually")
  })

  it("names the currency the payment was actually captured in", async () => {
    // The heldForReview push fires on refusals that include `non-usd`. Assuming
    // USD rendered a J$6,000 payment as "$6000.00" — a ~150x overstatement in
    // the one message whose entire job is telling the customer what we hold.
    await sendFygaroTopupNotification({
      accountId: ACCOUNT_ID,
      outcome: "heldForReview",
      amountCents: 600000,
      currency: "JMD",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.body).toContain("6000.00 JMD")
    expect(args.body).not.toContain("USD")
    expect(args.data).toMatchObject({ amount: "6000.00", currency: "JMD" })
  })

  it("sends in the user's language", async () => {
    mockFindUserById.mockResolvedValue({ deviceTokens: ["tok-1"], language: "es" })

    await sendFygaroTopupNotification({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
      currency: "USD",
    })

    expect(mockSendFiltered.mock.calls[0][0].title).toBe("Recarga completada")
  })

  it("returns the error rather than throwing when the account cannot be read", async () => {
    mockFindAccountById.mockResolvedValue(new Error("mongo down"))

    const res = await sendFygaroTopupNotification({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
      currency: "USD",
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
        currency: "USD",
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
      currency: "USD",
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
        currency: "USD",
      }),
    ).resolves.toBeUndefined()
  })
})
