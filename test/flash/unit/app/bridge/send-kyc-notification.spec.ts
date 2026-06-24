import {
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
import BridgeApiClient from "@services/bridge/client"

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

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: {
    getKycLatestLink: jest.fn(),
  },
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
  it.each([
    [undefined, false],
    ["open", true],
    ["not_started", true],
    ["approved", true],
  ])("returns %s for %s", (status, expected) => {
    expect(isBridgeKycInitiated(status)).toBe(expected)
  })
})

describe("toBridgeKycNotificationOutcome", () => {
  it.each([
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["offboarded", "offboarded"],
    ["under_review", "in_review"],
    ["incomplete", "incomplete"],
    ["open", "in_review"],
    ["not_started", null],
    [undefined, null],
  ])("maps %s to %s", (status, expected) => {
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
    ;(BridgeApiClient.getKycLatestLink as jest.Mock).mockResolvedValue({
      kyc_link: "https://bridge.xyz/kyc/abc",
      tos_link: "https://bridge.xyz/tos/abc",
      customer_id: bridgeCustomerId,
    })
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

  it("includes KYC links in incomplete notification data", async () => {
    await sendBridgeKycNotification({
      accountId,
      outcome: "incomplete",
      kycStatus: "incomplete",
    })

    expect(BridgeApiClient.getKycLatestLink).toHaveBeenCalledWith(bridgeCustomerId)
    expect(sendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "bridge_kyc_incomplete",
          status: "incomplete",
          kycLink: "https://bridge.xyz/kyc/abc",
          tosLink: "https://bridge.xyz/tos/abc",
        }),
      }),
    )
    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: "notification.bridgeKyc.incomplete.title" }),
    )
  })

  it("still sends incomplete notification when KYC link fetch fails", async () => {
    ;(BridgeApiClient.getKycLatestLink as jest.Mock).mockRejectedValue(new Error("Bridge unavailable"))

    const result = await sendBridgeKycNotification({
      accountId,
      outcome: "incomplete",
      kycStatus: "incomplete",
    })

    expect(result).toBe(true)
    expect(sendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          type: "bridge_kyc_incomplete",
          status: "incomplete",
        },
      }),
    )
  })

  it("does not fetch KYC links for non-incomplete notifications", async () => {
    await sendBridgeKycNotification({
      accountId,
      outcome: "approved",
      kycStatus: "approved",
    })

    expect(BridgeApiClient.getKycLatestLink).not.toHaveBeenCalled()
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
