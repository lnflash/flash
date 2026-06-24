import {
  BridgeKycNotificationOutcome,
  isBridgeKycInitiated,
  sendBridgeKycNotification,
  toBridgeKycNotificationOutcome,
} from "@app/bridge/send-kyc-notification"
import { AccountsRepository } from "@services/mongoose/accounts"
import { UsersRepository } from "@services/mongoose/users"
import {
  PushNotificationsService,
  SendFilteredPushNotificationStatus,
} from "@services/notifications/push-notifications"
import { getI18nInstance } from "@config"

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/users", () => ({
  UsersRepository: jest.fn(),
}))

jest.mock("@services/notifications/push-notifications", () => ({
  PushNotificationsService: jest.fn(),
  SendFilteredPushNotificationStatus: {
    Filtered: "filtered",
    Sent: "sent",
  },
}))

jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: jest.fn(),
}))

jest.mock("@config", () => {
  const mockI18n = {
    __: jest.fn().mockImplementation(({ phrase }, options) => `${phrase} ${JSON.stringify(options)}`),
  }
  return {
    getI18nInstance: jest.fn(() => mockI18n),
  }
})

describe("isBridgeKycInitiated", () => {
  const cases: Array<[Account["bridgeKycStatus"], boolean]> = [
    [undefined, false],
    ["open", true],
    ["not_started", true],
    ["approved", true],
  ]

  it.each(cases)("returns %s for %s", (status, expected) => {
    expect(isBridgeKycInitiated(status)).toBe(expected)
  })
})

describe("toBridgeKycNotificationOutcome", () => {
  const cases: Array<[Account["bridgeKycStatus"], BridgeKycNotificationOutcome | null]> = [
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["offboarded", "offboarded"],
    ["under_review", "in_review"],
    ["incomplete", "incomplete"],
    ["open", "in_review"],
    ["not_started", null],
    [undefined, null],
  ]

  it.each(cases)("maps %s to %s", (status, expected) => {
    expect(toBridgeKycNotificationOutcome(status)).toBe(expected)
  })
})

describe("sendBridgeKycNotification", () => {
  const accountId = "507f1f77bcf86cd799439011"
  const bridgeCustomerId = "cus_test_123"
  const mockAccount = {
    id: accountId,
    kratosUserId: "user-id",
    bridgeCustomerId,
    notificationSettings: { push: { enabled: true, disabledCategories: [] } },
  }
  const mockUser = {
    deviceTokens: ["token-1"],
    language: "en",
  }

  const sendFilteredNotification = jest.fn().mockResolvedValue({
    status: SendFilteredPushNotificationStatus.Sent,
  })
  const mockI18n = getI18nInstance()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue(mockAccount),
    })
    ;(UsersRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue(mockUser),
    })
    ;(PushNotificationsService as jest.Mock).mockReturnValue({
      sendFilteredNotification,
    })
    ;(getI18nInstance as jest.Mock).mockReturnValue(mockI18n)
  })

  it("sends an approved KYC notification with Payments category", async () => {
    const result = await sendBridgeKycNotification({
      accountId,
      outcome: "approved",
      kycStatus: "approved",
    })

    expect(result).toBe(true)
    expect(sendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceTokens: mockUser.deviceTokens,
        notificationCategory: "Payments",
        data: expect.objectContaining({ type: "bridge_kyc_approved", status: "approved" }),
      }),
    )
    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: "notification.bridgeKyc.approved.title" }),
    )
  })

  it("uses bodyWithReason when rejection reasons are provided", async () => {
    await sendBridgeKycNotification({
      accountId,
      outcome: "rejected",
      kycStatus: "rejected",
      rejectionReasons: [{ reason: "Document unreadable" }],
    })

    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({
        phrase: "notification.bridgeKyc.rejected.bodyWithReason",
      }),
      expect.objectContaining({ reason: "Document unreadable" }),
    )
  })

  it("does not include raw KYC links in incomplete notification data", async () => {
    await sendBridgeKycNotification({
      accountId,
      outcome: "incomplete",
      kycStatus: "incomplete",
    })

    expect(sendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "bridge_kyc_incomplete",
          status: "incomplete",
        }),
      }),
    )
    const payload = sendFilteredNotification.mock.calls[0][0].data
    expect(payload).not.toHaveProperty("kycLink")
    expect(payload).not.toHaveProperty("tosLink")
    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: "notification.bridgeKyc.incomplete.title" }),
    )
  })

  it("sends an in-review KYC notification", async () => {
    await sendBridgeKycNotification({
      accountId,
      outcome: "in_review",
      kycStatus: "under_review",
    })

    expect(sendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "bridge_kyc_in_review", status: "under_review" }),
      }),
    )
  })

  it("returns true when notification is filtered by user settings", async () => {
    sendFilteredNotification.mockResolvedValue({
      status: SendFilteredPushNotificationStatus.Filtered,
    })

    const result = await sendBridgeKycNotification({
      accountId,
      outcome: "approved",
      kycStatus: "approved",
    })

    expect(result).toBe(true)
  })
})
