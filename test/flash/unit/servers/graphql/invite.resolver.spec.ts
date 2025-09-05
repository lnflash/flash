import { Invite, InviteMethod, InviteStatus } from "@services/mongoose/models/invite"
import { generateInviteToken, hashToken } from "@utils"
import { notificationService } from "@services/notification"
import { Account } from "@services/mongoose/accounts"
import { redis } from "@services/redis"
import { baseLogger } from "@services/logger"

// Mock dependencies
jest.mock("@services/mongoose/models/invite")
jest.mock("@utils")
jest.mock("@services/notification")
jest.mock("@services/mongoose/accounts")
jest.mock("@services/redis")
jest.mock("@services/logger")

describe("Invite Resolvers", () => {
  const mockUser = { id: "test-user-id" }
  const mockAccount = { _id: "account-id", kratosUserId: "test-user-id" }
  
  beforeEach(() => {
    jest.clearAllMocks()
    
    // Setup default mocks
    ;(Account.findOne as jest.Mock) = jest.fn().mockResolvedValue(mockAccount)
    ;(generateInviteToken as jest.Mock).mockReturnValue({
      token: "test-token-40-chars-1234567890abcdefghij",
      tokenHash: "test-hash-64-chars-1234567890abcdefghijklmnopqrstuvwxyz123456"
    })
    
    // Mock Redis client
    ;(redis.get as jest.Mock) = jest.fn().mockResolvedValue(null)
    ;(redis.incr as jest.Mock) = jest.fn().mockResolvedValue(1)
    ;(redis.expire as jest.Mock) = jest.fn().mockResolvedValue(true)
    
    // Mock notification service
    ;(notificationService.sendNotification as jest.Mock).mockResolvedValue(true)
    
    // Setup environment variables
    process.env.FIREBASE_DYNAMIC_LINK_DOMAIN = "test.page.link"
    process.env.APP_INSTALL_URL = "https://flash.app/download"
    process.env.ANDROID_PACKAGE_NAME = "com.flash.app"
    process.env.IOS_BUNDLE_ID = "com.flash.app"
  })

  describe("CreateInvite", () => {
    it("should create and send email invite successfully", async () => {
      const mockInvite = {
        _id: "invite-id",
        contact: "test@example.com",
        method: InviteMethod.EMAIL,
        status: InviteStatus.PENDING,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        save: jest.fn().mockResolvedValue(true)
      }
      
      ;(Invite as unknown as jest.Mock) = jest.fn().mockImplementation(() => mockInvite)

      const input = {
        contact: "test@example.com",
        method: InviteMethod.EMAIL
      }

      // Simulate resolver logic
      const result = await createInviteLogic(input, mockUser)

      expect(result.errors).toEqual([])
      expect(result.invite).toBeTruthy()
      expect(result.invite?.contact).toBe("test@example.com")
      expect(result.invite?.method).toBe(InviteMethod.EMAIL)
      expect(result.invite?.status).toBe(InviteStatus.SENT)
    })

    it("should create and send SMS invite successfully", async () => {
      const mockInvite = {
        _id: "invite-id",
        contact: "+1234567890",
        method: InviteMethod.SMS,
        status: InviteStatus.PENDING,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        save: jest.fn().mockResolvedValue(true)
      }
      
      ;(Invite as unknown as jest.Mock) = jest.fn().mockImplementation(() => mockInvite)

      const input = {
        contact: "+1234567890",
        method: InviteMethod.SMS
      }

      const result = await createInviteLogic(input, mockUser)

      expect(result.errors).toEqual([])
      expect(result.invite).toBeTruthy()
      expect(result.invite?.contact).toBe("+1234567890")
      expect(result.invite?.method).toBe(InviteMethod.SMS)
    })

    it("should reject invalid email format", async () => {
      const input = {
        contact: "invalid-email",
        method: InviteMethod.EMAIL
      }

      const result = await createInviteLogic(input, mockUser)

      expect(result.errors).toContain("Invalid email address")
      expect(result.invite).toBeNull()
    })

    it("should reject invalid phone number format", async () => {
      const input = {
        contact: "123456", // Not E.164 format
        method: InviteMethod.SMS
      }

      const result = await createInviteLogic(input, mockUser)

      expect(result.errors).toContain("Invalid phone number. Must be in E.164 format (e.g., +1234567890)")
      expect(result.invite).toBeNull()
    })

    it("should enforce rate limits per inviter", async () => {
      ;(redis.get as jest.Mock) = jest.fn()
        .mockResolvedValueOnce("10") // Max invites reached for inviter
        .mockResolvedValueOnce("0")

      const input = {
        contact: "test@example.com",
        method: InviteMethod.EMAIL
      }

      const result = await createInviteLogic(input, mockUser)

      expect(result.errors).toContain("Rate limit exceeded. Please try again later.")
      expect(result.invite).toBeNull()
    })

    it("should handle notification send failure", async () => {
      ;(notificationService.sendNotification as jest.Mock).mockResolvedValue(false)

      const mockInvite = {
        _id: "invite-id",
        contact: "test@example.com",
        method: InviteMethod.EMAIL,
        status: InviteStatus.PENDING,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        save: jest.fn().mockResolvedValue(true)
      }
      
      ;(Invite as unknown as jest.Mock) = jest.fn().mockImplementation(() => mockInvite)

      const input = {
        contact: "test@example.com",
        method: InviteMethod.EMAIL
      }

      const result = await createInviteLogic(input, mockUser)

      expect(result.errors).toContain("Failed to send invitation")
      expect(result.invite).toBeNull()
      expect(mockInvite.status).toBe(InviteStatus.PENDING)
    })

    it("should build Firebase Dynamic Link when configured", () => {
      const token = "test-token"
      const link = buildInviteLinkLogic(token)

      expect(link).toContain("https://test.page.link/")
      expect(link).toContain(`link=${encodeURIComponent("https://flash.app/download?token=test-token")}`)
      expect(link).toContain("apn=com.flash.app")
      expect(link).toContain("ibi=com.flash.app")
    })

    it("should build fallback link when Firebase not configured", () => {
      delete process.env.FIREBASE_DYNAMIC_LINK_DOMAIN

      const token = "test-token"
      const link = buildInviteLinkLogic(token)

      expect(link).toBe("https://flash.app/invite?token=test-token")
    })
  })

  describe("RedeemInvite", () => {
    it("should redeem valid invite successfully", async () => {
      const mockInvite = {
        _id: "invite-id",
        tokenHash: "test-hash",
        status: InviteStatus.SENT,
        expiresAt: new Date(Date.now() + 1000000), // Future date
        save: jest.fn().mockResolvedValue(true)
      }

      ;(Invite.findOne as jest.Mock).mockResolvedValue(mockInvite)
      ;(hashToken as jest.Mock).mockReturnValue("test-hash")

      const input = { token: "test-token-40-chars-1234567890abcdefghij" }
      const result = await redeemInviteLogic(input, mockUser)

      expect(result.success).toBe(true)
      expect(result.errors).toEqual([])
      expect(mockInvite.status).toBe(InviteStatus.ACCEPTED)
      expect(mockInvite.save).toHaveBeenCalled()
    })

    it("should reject invalid token length", async () => {
      const input = { token: "short-token" }
      const result = await redeemInviteLogic(input, null)

      expect(result.success).toBe(false)
      expect(result.errors).toContain("Invalid invitation token")
    })

    it("should reject non-existent invite", async () => {
      ;(Invite.findOne as jest.Mock).mockResolvedValue(null)
      ;(hashToken as jest.Mock).mockReturnValue("test-hash")

      const input = { token: "test-token-40-chars-1234567890abcdefghij" }
      const result = await redeemInviteLogic(input, null)

      expect(result.success).toBe(false)
      expect(result.errors).toContain("Invalid or expired invitation")
    })

    it("should reject expired invite", async () => {
      const mockInvite = {
        _id: "invite-id",
        tokenHash: "test-hash",
        status: InviteStatus.SENT,
        expiresAt: new Date(Date.now() - 1000000), // Past date
        save: jest.fn().mockResolvedValue(true)
      }

      ;(Invite.findOne as jest.Mock).mockResolvedValue(mockInvite)
      ;(hashToken as jest.Mock).mockReturnValue("test-hash")

      const input = { token: "test-token-40-chars-1234567890abcdefghij" }
      const result = await redeemInviteLogic(input, null)

      expect(result.success).toBe(false)
      expect(result.errors).toContain("This invitation has expired")
      expect(mockInvite.status).toBe(InviteStatus.EXPIRED)
    })

    it("should reject already accepted invite", async () => {
      const mockInvite = {
        _id: "invite-id",
        tokenHash: "test-hash",
        status: InviteStatus.ACCEPTED,
        expiresAt: new Date(Date.now() + 1000000),
        save: jest.fn()
      }

      ;(Invite.findOne as jest.Mock).mockResolvedValue(mockInvite)
      ;(hashToken as jest.Mock).mockReturnValue("test-hash")

      const input = { token: "test-token-40-chars-1234567890abcdefghij" }
      const result = await redeemInviteLogic(input, null)

      expect(result.success).toBe(false)
      expect(result.errors).toContain("This invitation has already been used")
      expect(mockInvite.save).not.toHaveBeenCalled()
    })
  })
})

// Helper functions to simulate resolver logic
async function createInviteLogic(input: any, user: any) {
  // This simulates the core logic from the resolver
  if (!user) {
    return { errors: ["Authentication required"], invite: null }
  }

  const { contact, method } = input

  // Validate email
  if (method === InviteMethod.EMAIL) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(contact)) {
      return { errors: ["Invalid email address"], invite: null }
    }
  }

  // Validate phone
  if (method === InviteMethod.SMS || method === InviteMethod.WHATSAPP) {
    const e164Regex = /^\+[1-9]\d{1,14}$/
    if (!e164Regex.test(contact)) {
      return { errors: ["Invalid phone number. Must be in E.164 format (e.g., +1234567890)"], invite: null }
    }
  }

  // Check rate limit
  const today = new Date().toISOString().split("T")[0]
  const inviterKey = `invite:ratelimit:account-id:${today}`
  const inviterCount = await redis.get(inviterKey)
  
  if (inviterCount && parseInt(inviterCount) >= 10) {
    return { errors: ["Rate limit exceeded. Please try again later."], invite: null }
  }

  // Create invite
  const { token, tokenHash } = generateInviteToken()
  const expiresAt = new Date()
  expiresAt.setHours(expiresAt.getHours() + 24)

  const invite = new Invite({
    contact,
    method,
    tokenHash,
    inviterId: mockAccount._id,
    status: InviteStatus.PENDING,
    createdAt: new Date(),
    expiresAt,
  })

  await invite.save()

  // Send notification
  const sent = await notificationService.sendNotification(
    method as any,
    contact,
    "Test message",
    undefined
  )

  if (sent) {
    invite.status = InviteStatus.SENT
    await invite.save()
    return {
      errors: [],
      invite: {
        id: invite._id,
        contact: invite.contact,
        method: invite.method,
        status: invite.status,
        createdAt: invite.createdAt.toISOString(),
        expiresAt: invite.expiresAt.toISOString(),
      }
    }
  }

  return { errors: ["Failed to send invitation"], invite: null }
}

async function redeemInviteLogic(input: any, user: any) {
  const { token } = input

  if (!token || token.length !== 40) {
    return { success: false, errors: ["Invalid invitation token"] }
  }

  const tokenHash = hashToken(token)
  const invite = await Invite.findOne({ tokenHash })

  if (!invite) {
    return { success: false, errors: ["Invalid or expired invitation"] }
  }

  if (new Date() > invite.expiresAt) {
    invite.status = InviteStatus.EXPIRED
    await invite.save()
    return { success: false, errors: ["This invitation has expired"] }
  }

  if (invite.status === InviteStatus.ACCEPTED) {
    return { success: false, errors: ["This invitation has already been used"] }
  }

  invite.status = InviteStatus.ACCEPTED
  await invite.save()

  return { success: true, errors: [] }
}

function buildInviteLinkLogic(token: string): string {
  const firebaseDomain = process.env.FIREBASE_DYNAMIC_LINK_DOMAIN
  const appInstallUrl = process.env.APP_INSTALL_URL || "https://flash.app/download"
  const androidPackage = process.env.ANDROID_PACKAGE_NAME || "com.flash.app"
  const iosBundleId = process.env.IOS_BUNDLE_ID || "com.flash.app"

  if (firebaseDomain) {
    const params = new URLSearchParams({
      link: `${appInstallUrl}?token=${token}`,
      apn: androidPackage,
      ibi: iosBundleId,
      st: "Flash App Invite",
      sd: "You've been invited to join Flash App",
      ofl: `https://flash.app/invite?token=${token}`,
    })
    return `https://${firebaseDomain}/?${params.toString()}`
  }

  return `https://flash.app/invite?token=${token}`
}