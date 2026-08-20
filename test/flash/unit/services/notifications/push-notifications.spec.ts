const mockSendEachForMulticast = jest.fn()
let mockMessaging: unknown = { sendEachForMulticast: mockSendEachForMulticast }

jest.mock("@services/notifications/firebase", () => ({
  get messaging() {
    return mockMessaging
  },
}))

jest.mock("@services/tracing", () => ({
  wrapAsyncToRunInSpan:
    ({ fn }: { fn: (...args: unknown[]) => unknown }) =>
    (...args: unknown[]) =>
      fn(...args),
  recordExceptionInCurrentSpan: jest.fn(),
  addAttributesToCurrentSpan: jest.fn(),
}))

import {
  DeviceTokensNotRegisteredNotificationsServiceError,
  InvalidDeviceNotificationsServiceError,
  NoDeviceAcceptedPushNotificationsServiceError,
  NotificationsServiceError,
} from "@domain/notifications"
import { PushNotificationsService } from "@services/notifications/push-notifications"

const NOT_REGISTERED = "messaging/registration-token-not-registered"

const args = {
  deviceTokens: ["token-1", "token-2"] as DeviceToken[],
  title: "Update available",
  body: "Please update your Flash app.",
}

describe("PushNotificationsService.sendNotification", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMessaging = { sendEachForMulticast: mockSendEachForMulticast }
  })

  it("returns true when at least one device accepted the push", async () => {
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 2,
      failureCount: 0,
      responses: [{ success: true }, { success: true }],
    })

    const result = await PushNotificationsService().sendNotification(args)

    expect(result).toBe(true)
  })

  it("does not report success when every token failed for a non-stale reason", async () => {
    // Expired APNs auth key: the token is not "unregistered", so nothing lands
    // in invalidTokens — but nothing was delivered either.
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 0,
      failureCount: 2,
      responses: [
        { success: false, error: { code: "messaging/third-party-auth-error" } },
        { success: false, error: { code: "messaging/third-party-auth-error" } },
      ],
    })

    const result = await PushNotificationsService().sendNotification(args)

    expect(result).toBeInstanceOf(NotificationsServiceError)
    expect((result as NotificationsServiceError).message).toMatch(
      /no device accepted the push/i,
    )
  })

  it("carries the distinct FCM failure codes on the no-device-accepted error", async () => {
    // The caller escalates this to engineering. Without the codes the
    // escalation says "push is broken" and nothing else — the per-token warn
    // lines are keyed by token only, with no account on them.
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 0,
      failureCount: 3,
      responses: [
        { success: false, error: { code: "messaging/third-party-auth-error" } },
        { success: false, error: { code: "messaging/third-party-auth-error" } },
        { success: false, error: { code: "messaging/mismatched-credential" } },
      ],
    })

    const result = await PushNotificationsService().sendNotification({
      ...args,
      deviceTokens: ["token-1", "token-2", "token-3"] as DeviceToken[],
    })

    expect(result).toBeInstanceOf(NoDeviceAcceptedPushNotificationsServiceError)
    // Deduped: a large fleet failing on one bad key must not emit one entry per
    // device.
    expect(
      (result as NoDeviceAcceptedPushNotificationsServiceError).failureCodes,
    ).toEqual(["messaging/third-party-auth-error", "messaging/mismatched-credential"])
  })

  it("carries the failure codes on the stale-token error too", async () => {
    // Mixed fleet: the caller turns this into a no-device-accepted escalation
    // when successCount is 0, so the codes have to survive that hop.
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 0,
      failureCount: 2,
      responses: [
        { success: false, error: { code: NOT_REGISTERED } },
        { success: false, error: { code: "messaging/third-party-auth-error" } },
      ],
    })

    const result = await PushNotificationsService().sendNotification(args)

    expect(result).toBeInstanceOf(DeviceTokensNotRegisteredNotificationsServiceError)
    expect(
      (result as DeviceTokensNotRegisteredNotificationsServiceError).failureCodes,
    ).toEqual([NOT_REGISTERED, "messaging/third-party-auth-error"])
  })

  it("reports the real success count alongside the stale tokens", async () => {
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [{ success: false, error: { code: NOT_REGISTERED } }, { success: true }],
    })

    const result = await PushNotificationsService().sendNotification(args)

    expect(result).toBeInstanceOf(DeviceTokensNotRegisteredNotificationsServiceError)
    const err = result as DeviceTokensNotRegisteredNotificationsServiceError
    expect(err.tokens).toEqual(["token-1"])
    expect(err.successCount).toBe(1)
  })

  it("reports successCount 0 when the only non-stale token failed too", async () => {
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 0,
      failureCount: 2,
      responses: [
        { success: false, error: { code: NOT_REGISTERED } },
        { success: false, error: { code: "messaging/third-party-auth-error" } },
      ],
    })

    const result = await PushNotificationsService().sendNotification(args)

    expect(result).toBeInstanceOf(DeviceTokensNotRegisteredNotificationsServiceError)
    const err = result as DeviceTokensNotRegisteredNotificationsServiceError
    expect(err.tokens).toEqual(["token-1"])
    expect(err.successCount).toBe(0)
  })

  it("returns an error rather than true when firebase is not initialised", async () => {
    mockMessaging = null

    const result = await PushNotificationsService().sendNotification(args)

    expect(result).toBeInstanceOf(NotificationsServiceError)
    expect((result as NotificationsServiceError).message).toMatch(
      /firebase messaging module not loaded/i,
    )
    expect(mockSendEachForMulticast).not.toHaveBeenCalled()
  })

  it("returns InvalidDevice when the user has no device tokens", async () => {
    const result = await PushNotificationsService().sendNotification({
      ...args,
      deviceTokens: [] as DeviceToken[],
    })

    expect(result).toBeInstanceOf(InvalidDeviceNotificationsServiceError)
    expect(mockSendEachForMulticast).not.toHaveBeenCalled()
  })
})
