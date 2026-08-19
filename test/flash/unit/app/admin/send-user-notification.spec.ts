import { sendUserNotification } from "@app/admin/send-user-notification"
import { removeDeviceTokens } from "@app/users/remove-device-tokens"
import {
  AllDeviceTokensStaleNotificationsServiceError,
  DeviceTokensNotRegisteredNotificationsServiceError,
  FlashNotificationCategories,
  InvalidDeviceNotificationsServiceError,
  NoDeviceAcceptedPushNotificationsServiceError,
  NotificationsServiceError,
  RecipientDisabledNotificationsServiceError,
} from "@domain/notifications"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose/accounts"
import { UsersRepository } from "@services/mongoose/users"
import {
  PushNotificationsService,
  SendFilteredPushNotificationStatus,
} from "@services/notifications/push-notifications"

jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: jest.fn(),
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/users", () => ({
  UsersRepository: jest.fn(),
}))

jest.mock("@services/notifications/push-notifications", () => ({
  PushNotificationsService: jest.fn(),
  SendFilteredPushNotificationStatus: { Sent: "Sent", Filtered: "Filtered" },
}))

describe("sendUserNotification", () => {
  const accountId = "account-id" as AccountUuid
  const title = "Please update your app"
  const body = "A new version of Flash is available."
  const sentBy = "support-user-id" as UserId

  const notificationSettings = {
    push: { enabled: true, disabledCategories: [] },
  } as unknown as NotificationSettings

  const mockAccount = {
    uuid: accountId,
    kratosUserId: "user-id",
    notificationSettings,
  }

  const mockUser = {
    deviceTokens: ["token-1", "token-2"],
  }

  const sendFilteredNotification = jest
    .fn()
    .mockResolvedValue({ status: SendFilteredPushNotificationStatus.Sent })
  // Exposed on the mocked service so a regression back to the unfiltered path
  // shows up as a failed assertion rather than a TypeError.
  const sendNotification = jest.fn().mockResolvedValue(true)

  beforeEach(() => {
    jest.clearAllMocks()
    sendFilteredNotification.mockResolvedValue({
      status: SendFilteredPushNotificationStatus.Sent,
    })
    sendNotification.mockResolvedValue(true)
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findByUuid: jest.fn().mockResolvedValue(mockAccount),
    })
    ;(UsersRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue(mockUser),
    })
    ;(PushNotificationsService as jest.Mock).mockReturnValue({
      sendFilteredNotification,
      sendNotification,
    })
  })

  it("sends the notification to the user's device tokens", async () => {
    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBe(true)
    expect(sendFilteredNotification).toHaveBeenCalledWith({
      deviceTokens: mockUser.deviceTokens,
      title,
      body,
      notificationCategory: FlashNotificationCategories.AdminPushNotification,
      notificationSettings,
    })
  })

  it("honors the recipient's notification settings rather than bypassing them", async () => {
    // The raw sendNotification path ignores the user's in-app toggles. This
    // must go through the filtered path like every other user-facing push, or
    // an opted-out user gets a push they explicitly refused.
    await sendUserNotification({ accountId, title, body, sentBy })

    expect(sendFilteredNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it("fails when the recipient has admin notifications disabled", async () => {
    sendFilteredNotification.mockResolvedValue({
      status: SendFilteredPushNotificationStatus.Filtered,
    })

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    // Nothing was handed to Firebase, so this must never read as a success.
    expect(result).toBeInstanceOf(RecipientDisabledNotificationsServiceError)
  })

  it("records the operator who triggered the send", async () => {
    // The admin server never assigns req.gqlContext, so PinoHttp logs
    // "gqlContext.user": undefined — this line is the only attribution.
    const info = jest.spyOn(baseLogger, "info").mockImplementation(jest.fn() as never)

    await sendUserNotification({ accountId, title, body, sentBy })

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, sentBy, title }),
      // "requested", not "sent": it is emitted before a send that can still be
      // refused or fail, so grepping it counts attempts, not deliveries.
      expect.stringMatching(/admin user notification requested/i),
    )

    info.mockRestore()
  })

  it("records the body alongside the operator, not just the title", async () => {
    // "Flash told me to call this number" has to be traceable to an operator
    // from one log line. push-notifications logs the body with no accountId and
    // no sentBy, so without this the two can only be joined by device token and
    // timestamp.
    const info = jest.spyOn(baseLogger, "info").mockImplementation(jest.fn() as never)

    await sendUserNotification({ accountId, title, body, sentBy })

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, sentBy, title, body }),
      expect.stringMatching(/admin user notification requested/i),
    )

    info.mockRestore()
  })

  it("records the outcome, not just the attempt", async () => {
    const info = jest.spyOn(baseLogger, "info").mockImplementation(jest.fn() as never)

    await sendUserNotification({ accountId, title, body, sentBy })

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, sentBy, outcome: "delivered" }),
      expect.stringMatching(/admin user notification result/i),
    )

    info.mockRestore()
  })

  it("records a filtered send as filtered, not as delivered", async () => {
    sendFilteredNotification.mockResolvedValue({
      status: SendFilteredPushNotificationStatus.Filtered,
    })
    const info = jest.spyOn(baseLogger, "info").mockImplementation(jest.fn() as never)

    await sendUserNotification({ accountId, title, body, sentBy })

    // Nothing reached Firebase; the outcome line is what corrects the record
    // the "requested" line would otherwise leave looking like a delivery.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "filtered-recipient-opted-out" }),
      expect.stringMatching(/admin user notification result/i),
    )

    info.mockRestore()
  })

  it("looks the user up via the account's kratos user id", async () => {
    const findById = jest.fn().mockResolvedValue(mockUser)
    ;(UsersRepository as jest.Mock).mockReturnValue({ findById })

    await sendUserNotification({ accountId, title, body, sentBy })

    expect(findById).toHaveBeenCalledWith(mockAccount.kratosUserId)
  })

  it("returns error if account is not found", async () => {
    const error = new Error("Account not found")
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findByUuid: jest.fn().mockResolvedValue(error),
    })

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBe(error)
    expect(sendFilteredNotification).not.toHaveBeenCalled()
  })

  it("returns error if user is not found", async () => {
    const error = new Error("User not found")
    ;(UsersRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue(error),
    })

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBe(error)
    expect(sendFilteredNotification).not.toHaveBeenCalled()
  })

  it("returns the notifications service error if the push send fails", async () => {
    const info = jest.spyOn(baseLogger, "info").mockImplementation(jest.fn() as never)
    const error = new NotificationsServiceError("firebase down")
    sendFilteredNotification.mockResolvedValue(error)

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBe(error)
    expect(removeDeviceTokens).not.toHaveBeenCalled()
    // "send-failed" is the only outcome that means something is broken, so it
    // has to keep meaning that — see the no-device-tokens case below.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, sentBy, outcome: "send-failed" }),
      expect.stringMatching(/admin user notification result/i),
    )

    info.mockRestore()
  })

  it("logs a user with no device tokens as its own outcome, not as send-failed", async () => {
    // Zero registered tokens is the most common terminal state on a support
    // send and it is routine — the user never enabled push. Labelling it
    // "send-failed" puts it under the same outcome as a Firebase outage, so an
    // alert on the one label that means "something broke" fires on every
    // routine attempt, gets muted, and then hides the real outage. The API
    // already separates these (PUSH_NO_DEVICE_TOKENS vs UNEXPECTED_CLIENT_ERROR).
    const info = jest.spyOn(baseLogger, "info").mockImplementation(jest.fn() as never)
    ;(UsersRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue({ deviceTokens: [] }),
    })
    const error = new InvalidDeviceNotificationsServiceError()
    sendFilteredNotification.mockResolvedValue(error)

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBe(error)
    expect(removeDeviceTokens).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, sentBy, outcome: "no-device-tokens" }),
      expect.stringMatching(/admin user notification result/i),
    )
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "send-failed" }),
      expect.anything(),
    )

    info.mockRestore()
  })

  it("prunes stale tokens and succeeds when a live device accepted the push", async () => {
    // Firebase reports the stale token as an error even though delivery to
    // the live token succeeded — the send must count as a success.
    sendFilteredNotification.mockResolvedValue(
      new DeviceTokensNotRegisteredNotificationsServiceError(
        ["token-1"] as DeviceToken[],
        1,
      ),
    )

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBe(true)
    expect(removeDeviceTokens).toHaveBeenCalledWith({
      userId: mockAccount.kratosUserId,
      deviceTokens: ["token-1"],
    })
  })

  it("does not claim all tokens were stale when only some were", async () => {
    // Mixed fleet: token-1 is a dead Android install, token-2 is live iOS that
    // failed on broken APNs auth. Nothing was delivered, but token-2 was never
    // stale and was not cleared — so "all devices are stale, ask them to
    // reopen the app" would send the operator to the user instead of to eng.
    sendFilteredNotification.mockResolvedValue(
      new DeviceTokensNotRegisteredNotificationsServiceError(
        ["token-1"] as DeviceToken[],
        0,
        [
          "messaging/registration-token-not-registered",
          "messaging/third-party-auth-error",
        ],
      ),
    )

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBeInstanceOf(NoDeviceAcceptedPushNotificationsServiceError)
    expect(result).not.toBeInstanceOf(AllDeviceTokensStaleNotificationsServiceError)
    expect(removeDeviceTokens).toHaveBeenCalledWith({
      userId: mockAccount.kratosUserId,
      deviceTokens: ["token-1"],
    })
  })

  it("carries the FCM failure codes on the error and into the outcome log", async () => {
    // This branch tells the operator to escalate to engineering. Eng needs the
    // codes to tell an expired APNs auth key from a sender-id mismatch or a
    // quota trip; the per-token warn lines are keyed by token alone, with no
    // accountId and no sentBy on them.
    const info = jest.spyOn(baseLogger, "info").mockImplementation(jest.fn() as never)
    sendFilteredNotification.mockResolvedValue(
      new DeviceTokensNotRegisteredNotificationsServiceError(
        ["token-1"] as DeviceToken[],
        0,
        [
          "messaging/registration-token-not-registered",
          "messaging/third-party-auth-error",
        ],
      ),
    )

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(
      (result as NoDeviceAcceptedPushNotificationsServiceError).failureCodes,
    ).toEqual([
      "messaging/registration-token-not-registered",
      "messaging/third-party-auth-error",
    ])
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "no-device-accepted",
        failureCodes: [
          "messaging/registration-token-not-registered",
          "messaging/third-party-auth-error",
        ],
      }),
      expect.stringMatching(/admin user notification result/i),
    )

    info.mockRestore()
  })

  it("logs no-device-accepted with codes when every token failed non-stale", async () => {
    // Nothing was unregistered, so the service returns the typed error directly
    // rather than the stale-token one. Folding this into "send-failed" would
    // drop the only diagnosis the escalation has.
    const info = jest.spyOn(baseLogger, "info").mockImplementation(jest.fn() as never)
    sendFilteredNotification.mockResolvedValue(
      new NoDeviceAcceptedPushNotificationsServiceError("no device accepted the push", [
        "messaging/third-party-auth-error",
      ]),
    )

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBeInstanceOf(NoDeviceAcceptedPushNotificationsServiceError)
    expect(removeDeviceTokens).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "no-device-accepted",
        failureCodes: ["messaging/third-party-auth-error"],
      }),
      expect.stringMatching(/admin user notification result/i),
    )

    info.mockRestore()
  })

  it("prunes and fails when every token is stale", async () => {
    sendFilteredNotification.mockResolvedValue(
      new DeviceTokensNotRegisteredNotificationsServiceError(
        ["token-1", "token-2"] as DeviceToken[],
        0,
      ),
    )

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBeInstanceOf(AllDeviceTokensStaleNotificationsServiceError)
    expect(removeDeviceTokens).toHaveBeenCalledWith({
      userId: mockAccount.kratosUserId,
      deviceTokens: ["token-1", "token-2"],
    })
  })

  it("logs a warning when pruning the stale tokens fails", async () => {
    const warn = jest.spyOn(baseLogger, "warn").mockImplementation(jest.fn() as never)
    const pruneError = new Error("mongo write failed")
    ;(removeDeviceTokens as jest.Mock).mockResolvedValue(pruneError)
    sendFilteredNotification.mockResolvedValue(
      new DeviceTokensNotRegisteredNotificationsServiceError(
        ["token-1", "token-2"] as DeviceToken[],
        0,
      ),
    )

    const result = await sendUserNotification({ accountId, title, body, sentBy })

    expect(result).toBeInstanceOf(AllDeviceTokensStaleNotificationsServiceError)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, err: pruneError }),
      expect.stringMatching(/failed to prune stale device tokens/i),
    )

    warn.mockRestore()
  })
})
