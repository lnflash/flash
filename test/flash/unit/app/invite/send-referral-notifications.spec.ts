const mockI18n = jest.fn()
jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  getI18nInstance: () => ({ __: (...a: unknown[]) => mockI18n(...a) }),
}))

const mockAccountFindById = jest.fn()
jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: () => ({
    findById: (...a: unknown[]) => mockAccountFindById(...a),
  }),
}))

const mockUserFindById = jest.fn()
jest.mock("@services/mongoose/users", () => ({
  UsersRepository: () => ({ findById: (...a: unknown[]) => mockUserFindById(...a) }),
}))

const mockSendFiltered = jest.fn()
jest.mock("@services/notifications/push-notifications", () => {
  const actual = jest.requireActual("@services/notifications/push-notifications")
  return {
    SendFilteredPushNotificationStatus: actual.SendFilteredPushNotificationStatus,
    PushNotificationsService: () => ({
      sendFilteredNotification: (...a: unknown[]) => mockSendFiltered(...a),
    }),
  }
})

const mockRemoveTokens = jest.fn()
jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: (...a: unknown[]) => mockRemoveTokens(...a),
}))

jest.mock("@services/logger", () => {
  const stub: Record<string, unknown> = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  stub.child = () => stub
  return { baseLogger: stub }
})

import {
  sendInviteAcceptedNotificationBestEffort,
  sendReferralRewardNotificationBestEffort,
} from "@app/invite/send-referral-notifications"
import { DeviceTokensNotRegisteredNotificationsServiceError } from "@domain/notifications"
import { SendFilteredPushNotificationStatus } from "@services/notifications/push-notifications"

const ACCOUNT = "507f1f77bcf86cd799439011"
const TOKENS = ["tok-1", "tok-2"]

describe("referral push notifications", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAccountFindById.mockResolvedValue({
      id: ACCOUNT,
      kratosUserId: "kratos-1",
      notificationSettings: undefined,
    })
    mockUserFindById.mockResolvedValue({
      id: "kratos-1",
      language: "",
      deviceTokens: TOKENS,
    })
    mockI18n.mockImplementation((arg: { phrase: string }) => arg.phrase)
    mockSendFiltered.mockResolvedValue({
      status: SendFilteredPushNotificationStatus.Sent,
    })
  })

  it("sends the inviter-reward push with a formatted dollar amount", async () => {
    await sendReferralRewardNotificationBestEffort({
      accountId: ACCOUNT,
      leg: "inviter",
      amountCents: 500,
    })

    expect(mockI18n).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: "notification.referral.inviterReward.title" }),
    )
    expect(mockI18n).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: "notification.referral.inviterReward.body" }),
      expect.objectContaining({ amount: "5.00" }),
    )
    expect(mockSendFiltered).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceTokens: TOKENS,
        data: expect.objectContaining({
          type: "referral_inviterReward",
          amountCents: "500",
        }),
      }),
    )
  })

  it("sends the invitee-reward push under the invitee phrase set", async () => {
    await sendReferralRewardNotificationBestEffort({
      accountId: ACCOUNT,
      leg: "invitee",
      amountCents: 250,
    })
    expect(mockI18n).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: "notification.referral.inviteeReward.body" }),
      expect.objectContaining({ amount: "2.50" }),
    )
  })

  it("uses the named body when the invitee has a username", async () => {
    await sendInviteAcceptedNotificationBestEffort({
      inviterAccountId: ACCOUNT,
      inviteeName: "bob",
    })
    expect(mockI18n).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: "notification.referral.accepted.body" }),
      expect.objectContaining({ name: "bob" }),
    )
  })

  it("falls back to the no-name body when the invitee has no username", async () => {
    await sendInviteAcceptedNotificationBestEffort({ inviterAccountId: ACCOUNT })
    expect(mockI18n).toHaveBeenCalledWith(
      expect.objectContaining({ phrase: "notification.referral.accepted.bodyNoName" }),
      expect.anything(),
    )
  })

  it("prunes dead device tokens", async () => {
    mockSendFiltered.mockResolvedValue(
      new DeviceTokensNotRegisteredNotificationsServiceError(["dead-1" as DeviceToken]),
    )
    await sendInviteAcceptedNotificationBestEffort({ inviterAccountId: ACCOUNT })
    expect(mockRemoveTokens).toHaveBeenCalledWith(
      expect.objectContaining({ deviceTokens: ["dead-1"] }),
    )
  })

  it("never throws into the caller — push-service explosion is swallowed", async () => {
    mockSendFiltered.mockRejectedValue(new Error("fcm down"))
    await expect(
      sendReferralRewardNotificationBestEffort({
        accountId: ACCOUNT,
        leg: "invitee",
        amountCents: 500,
      }),
    ).resolves.toBeUndefined()
  })

  it("never throws when the account lookup fails", async () => {
    mockAccountFindById.mockResolvedValue(new Error("mongo down"))
    await expect(
      sendInviteAcceptedNotificationBestEffort({ inviterAccountId: ACCOUNT }),
    ).resolves.toBeUndefined()
    expect(mockSendFiltered).not.toHaveBeenCalled()
  })
})
