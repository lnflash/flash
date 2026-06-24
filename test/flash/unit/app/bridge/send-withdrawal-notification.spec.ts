import { sendBridgeWithdrawalNotification } from "@app/bridge/send-withdrawal-notification"
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

describe("sendBridgeWithdrawalNotification", () => {
  const accountId = "507f1f77bcf86cd799439011"
  const mockAccount = {
    id: accountId,
    kratosUserId: "user-id",
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

  it("sends a completed withdrawal notification with Cashout category", async () => {
    const result = await sendBridgeWithdrawalNotification({
      accountId,
      amount: "100.00",
      currency: "usdt",
      outcome: "completed",
    })

    expect(result).toBe(true)
    expect(sendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceTokens: mockUser.deviceTokens,
        notificationCategory: "Cashout",
        data: expect.objectContaining({ type: "bridge_withdrawal_completed" }),
      }),
    )
    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: "notification.bridgeWithdrawal.completed.title" }),
    )
  })

  it("uses bodyWithReason when a failure reason is provided", async () => {
    await sendBridgeWithdrawalNotification({
      accountId,
      amount: "50.00",
      currency: "usdt",
      outcome: "failed",
      failureReason: "ACH return",
    })

    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({
        phrase: "notification.bridgeWithdrawal.failed.bodyWithReason",
      }),
      expect.objectContaining({ reason: "ACH return" }),
    )
  })

  it("returns true when notification is filtered by user settings", async () => {
    sendFilteredNotification.mockResolvedValue({
      status: SendFilteredPushNotificationStatus.Filtered,
    })

    const result = await sendBridgeWithdrawalNotification({
      accountId,
      amount: "10.00",
      currency: "usdt",
      outcome: "completed",
    })

    expect(result).toBe(true)
  })

  it("sends a submitted withdrawal notification with the correct phrase key and data type", async () => {
    const result = await sendBridgeWithdrawalNotification({
      accountId,
      amount: "75.00",
      currency: "usdt",
      outcome: "submitted",
    })

    expect(result).toBe(true)
    expect(sendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "bridge_withdrawal_submitted" }),
      }),
    )
    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({
        phrase: "notification.bridgeWithdrawal.submitted.title",
      }),
    )
  })

  it("sends a usdt_sent withdrawal notification with the correct phrase key and data type", async () => {
    const result = await sendBridgeWithdrawalNotification({
      accountId,
      amount: "75.00",
      currency: "usdt",
      outcome: "usdt_sent",
    })

    expect(result).toBe(true)
    expect(sendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "bridge_withdrawal_usdt_sent" }),
      }),
    )
    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({
        phrase: "notification.bridgeWithdrawal.usdt_sent.title",
      }),
    )
  })

  it("sends a cancelled withdrawal notification with the correct phrase key and data type", async () => {
    const result = await sendBridgeWithdrawalNotification({
      accountId,
      amount: "25.00",
      currency: "usdt",
      outcome: "cancelled",
    })

    expect(result).toBe(true)
    expect(sendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceTokens: mockUser.deviceTokens,
        notificationCategory: "Cashout",
        data: expect.objectContaining({ type: "bridge_withdrawal_cancelled" }),
      }),
    )
    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({
        phrase: "notification.bridgeWithdrawal.cancelled.title",
      }),
    )
    expect(mockI18n.__).toHaveBeenCalledWith(
      expect.objectContaining({
        phrase: "notification.bridgeWithdrawal.cancelled.body",
      }),
      expect.objectContaining({ amount: "25.00 USDT" }),
    )
  })
})
