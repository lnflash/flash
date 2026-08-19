const mockGetAccountByUsername = jest.fn()
const mockSendUserNotification = jest.fn()

jest.mock("@app/index", () => ({
  Admin: {
    getAccountByUsername: (...args: unknown[]) => mockGetAccountByUsername(...args),
    sendUserNotification: (...args: unknown[]) => mockSendUserNotification(...args),
  },
}))

import { InvalidUsername, CouldNotFindAccountFromUsernameError } from "@domain/errors"
import {
  AllDeviceTokensStaleNotificationsServiceError,
  InvalidDeviceNotificationsServiceError,
  NoDeviceAcceptedPushNotificationsServiceError,
  NotificationsServiceError,
  RecipientDisabledNotificationsServiceError,
} from "@domain/notifications"
import UserNotificationSendMutation from "@graphql/admin/root/mutation/user-notification-send"

const VALID_ACCOUNT_UUID = "39c6e986-979b-40ab-9e7b-df18a9277a84"
const SUPPORT_USER_ID = "support-user-id"

type Result = {
  success?: boolean
  errors: { message: string; code?: string }[]
}

// Mirrors what graphql-admin-server's Apollo `context` fn builds from the
// decoded admin JWT — the resolver reads ctx.user.id off it.
const adminContext = () => ({
  logger: { error: jest.fn() },
  user: { id: SUPPORT_USER_ID, roles: ["support"], ip: "127.0.0.1" },
})

const resolveMutation = async (input: Record<string, unknown>): Promise<Result> => {
  const resolve = UserNotificationSendMutation.resolve as unknown as (
    source: null,
    args: { input: Record<string, unknown> },
    ctx: Record<string, unknown>,
  ) => Promise<Result>

  return resolve(null, { input }, adminContext())
}

describe("userNotificationSend", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendUserNotification.mockResolvedValue(true)
    mockGetAccountByUsername.mockResolvedValue({
      uuid: VALID_ACCOUNT_UUID,
      kratosUserId: "user-id",
    })
  })

  describe("input validation", () => {
    it("rejects when both accountId and username are provided", async () => {
      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        username: "jaceth2009",
        title: "t",
        body: "b",
      })

      expect(result.errors[0].message).toMatch(/exactly one of accountid or username/i)
      expect(result.success).toBe(false)
      expect(mockSendUserNotification).not.toHaveBeenCalled()
    })

    it("rejects when neither accountId nor username is provided", async () => {
      const result = await resolveMutation({ title: "t", body: "b" })

      expect(result.errors[0].message).toMatch(/exactly one of accountid or username/i)
      expect(result.success).toBe(false)
      expect(mockSendUserNotification).not.toHaveBeenCalled()
    })

    it("rejects an empty title", async () => {
      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "   ",
        body: "b",
      })

      expect(result.errors[0].message).toMatch(/title/i)
      expect(mockSendUserNotification).not.toHaveBeenCalled()
    })

    it("rejects a title over the max length", async () => {
      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "x".repeat(257),
        body: "b",
      })

      expect(result.errors[0].message).toMatch(/title/i)
      expect(mockSendUserNotification).not.toHaveBeenCalled()
    })

    it("rejects an empty body", async () => {
      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "t",
        body: "",
      })

      expect(result.errors[0].message).toMatch(/body/i)
      expect(mockSendUserNotification).not.toHaveBeenCalled()
    })

    it("rejects a body over the max length", async () => {
      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "t",
        body: "x".repeat(1025),
      })

      expect(result.errors[0].message).toMatch(/body/i)
      expect(mockSendUserNotification).not.toHaveBeenCalled()
    })

    it("rejects a malformed accountId", async () => {
      const result = await resolveMutation({
        accountId: "not-a-uuid",
        title: "t",
        body: "b",
      })

      expect(result.errors[0].message).toMatch(/invalid accountid/i)
      expect(mockSendUserNotification).not.toHaveBeenCalled()
    })

    it("rejects a malformed username", async () => {
      mockGetAccountByUsername.mockResolvedValue(new InvalidUsername("x"))

      const result = await resolveMutation({
        username: "x",
        title: "t",
        body: "b",
      })

      expect(result.errors[0].message).toMatch(/invalid username/i)
      expect(mockSendUserNotification).not.toHaveBeenCalled()
    })
  })

  describe("by accountId", () => {
    it("sends the notification and returns success", async () => {
      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "Update available",
        body: "Please update your Flash app.",
      })

      expect(result).toEqual({ errors: [], success: true })
      expect(mockSendUserNotification).toHaveBeenCalledWith({
        accountId: VALID_ACCOUNT_UUID,
        title: "Update available",
        body: "Please update your Flash app.",
        sentBy: SUPPORT_USER_ID,
      })
      expect(mockGetAccountByUsername).not.toHaveBeenCalled()
    })

    it("trims title and body before sending", async () => {
      await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "  Update available  ",
        body: "  Please update.  ",
      })

      expect(mockSendUserNotification).toHaveBeenCalledWith({
        accountId: VALID_ACCOUNT_UUID,
        title: "Update available",
        body: "Please update.",
        sentBy: SUPPORT_USER_ID,
      })
    })
  })

  describe("audit trail", () => {
    it("threads the calling operator into the app layer", async () => {
      // Without this, an arbitrary push to a named user from Flash's verified
      // FCM sender is unattributable: the admin server never assigns
      // req.gqlContext, so PinoHttp's "gqlContext.user" prop logs undefined.
      await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "Update available",
        body: "Please update your Flash app.",
      })

      expect(mockSendUserNotification).toHaveBeenCalledWith(
        expect.objectContaining({ sentBy: SUPPORT_USER_ID }),
      )
    })

    it("threads the calling operator through the username path too", async () => {
      await resolveMutation({
        username: "jaceth2009",
        title: "Update available",
        body: "Please update your Flash app.",
      })

      expect(mockSendUserNotification).toHaveBeenCalledWith(
        expect.objectContaining({ sentBy: SUPPORT_USER_ID }),
      )
    })
  })

  describe("by username", () => {
    it("resolves the account and sends the notification", async () => {
      const result = await resolveMutation({
        username: "jaceth2009",
        title: "Update available",
        body: "Please update your Flash app.",
      })

      expect(result).toEqual({ errors: [], success: true })
      expect(mockGetAccountByUsername).toHaveBeenCalledWith("jaceth2009")
      expect(mockSendUserNotification).toHaveBeenCalledWith({
        accountId: VALID_ACCOUNT_UUID,
        title: "Update available",
        body: "Please update your Flash app.",
        sentBy: SUPPORT_USER_ID,
      })
    })

    it("trims the username before resolving the account", async () => {
      // UsernameRegex rejects surrounding whitespace, so an untrimmed username
      // pasted out of a support ticket would read as "Invalid username".
      const result = await resolveMutation({
        username: "  jaceth2009  ",
        title: "Update available",
        body: "Please update your Flash app.",
      })

      expect(result).toEqual({ errors: [], success: true })
      expect(mockGetAccountByUsername).toHaveBeenCalledWith("jaceth2009")
    })

    it("returns a mapped error when the username does not exist", async () => {
      mockGetAccountByUsername.mockResolvedValue(
        new CouldNotFindAccountFromUsernameError("ghost"),
      )

      const result = await resolveMutation({
        username: "ghost",
        title: "t",
        body: "b",
      })

      expect(result.success).toBe(false)
      expect(result.errors).toHaveLength(1)
      // "does not exist" must not collapse into the "Invalid username" branch —
      // an operator who typos an existing username needs to know which it was.
      expect(result.errors[0].message).toMatch(/does not exist for username/i)
      expect(mockSendUserNotification).not.toHaveBeenCalled()
    })
  })

  describe("send failures", () => {
    it("returns a clear error when the user has no device tokens", async () => {
      mockSendUserNotification.mockResolvedValue(
        new InvalidDeviceNotificationsServiceError(),
      )

      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "t",
        body: "b",
      })

      expect(result.errors[0].message).toMatch(/no registered device tokens/i)
      expect(result.errors[0].code).toBe("PUSH_NO_DEVICE_TOKENS")
      expect(result.success).toBe(false)
    })

    it("distinguishes all-stale tokens from having no tokens at all", async () => {
      mockSendUserNotification.mockResolvedValue(
        new AllDeviceTokensStaleNotificationsServiceError(),
      )

      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "t",
        body: "b",
      })

      expect(result.success).toBe(false)
      expect(result.errors[0].message).toMatch(/stale/i)
      expect(result.errors[0].message).toMatch(/reopen the app/i)
      expect(result.errors[0].code).toBe("PUSH_ALL_TOKENS_STALE")
      // the operator must not be sent chasing "they never logged in"
      expect(result.errors[0].message).not.toMatch(/no registered device tokens/i)
    })

    it("points at push infrastructure when nothing was delivered but tokens were live", async () => {
      mockSendUserNotification.mockResolvedValue(
        new NoDeviceAcceptedPushNotificationsServiceError("no device accepted the push"),
      )

      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "t",
        body: "b",
      })

      expect(result.success).toBe(false)
      expect(result.errors[0].message).toMatch(/push infrastructure/i)
      expect(result.errors[0].code).toBe("PUSH_NO_DEVICE_ACCEPTED")
      // Must not send the operator chasing the user: the live token was never
      // stale and was never cleared, so reopening the app fixes nothing.
      expect(result.errors[0].message).not.toMatch(/reopen the app/i)
      // and must not fall through to the generic error-map wrapper
      expect(result.errors[0].message).not.toMatch(/unexpected error occurred/i)
    })

    it("reports an opted-out recipient instead of claiming success", async () => {
      mockSendUserNotification.mockResolvedValue(
        new RecipientDisabledNotificationsServiceError(),
      )

      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "t",
        body: "b",
      })

      expect(result.success).toBe(false)
      expect(result.errors[0].message).toMatch(/disabled admin notifications/i)
      expect(result.errors[0].code).toBe("PUSH_RECIPIENT_DISABLED")
      expect(result.errors[0].message).not.toMatch(/unexpected error occurred/i)
    })

    it("gives each terminal state its own machine-readable code", async () => {
      // The default PushNotificationError code is FIREBASE_ERROR. If these all
      // came back under it, the support panel could only tell "user opted out"
      // (ignore) from "push infrastructure is down" (page eng) by regexing the
      // English message — which a copy edit silently breaks.
      const codeFor = async (error: Error) => {
        mockSendUserNotification.mockResolvedValue(error)
        const result = await resolveMutation({
          accountId: VALID_ACCOUNT_UUID,
          title: "t",
          body: "b",
        })
        return result.errors[0].code
      }

      const codes = [
        await codeFor(new AllDeviceTokensStaleNotificationsServiceError()),
        await codeFor(new NoDeviceAcceptedPushNotificationsServiceError("nope")),
        await codeFor(new RecipientDisabledNotificationsServiceError()),
        await codeFor(new InvalidDeviceNotificationsServiceError()),
      ]

      expect(new Set(codes).size).toBe(codes.length)
      expect(codes).not.toContain("FIREBASE_ERROR")
    })

    it("returns a mapped error when the push send fails", async () => {
      mockSendUserNotification.mockResolvedValue(
        new NotificationsServiceError("firebase down"),
      )

      const result = await resolveMutation({
        accountId: VALID_ACCOUNT_UUID,
        title: "t",
        body: "b",
      })

      expect(result.success).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toMatch(/firebase down/i)
    })
  })
})
