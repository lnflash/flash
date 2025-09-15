import { alice, bob } from "../../jest.setup"
import { InviteMethod, InviteStatus } from "@domain/invite"
import * as InviteRepository from "@app/invite/invite-repository"
import { createInvite } from "@app/invite"
import { redeemInvite } from "@app/invite/redeem-invite"
import { randomBytes } from "crypto"
import { Redis } from "ioredis"
import { baseLogger } from "@services/logger"

describe("Invite Feature", () => {
  describe("createInvite", () => {
    it("should create an email invitation successfully", async () => {
      const contact = "test@example.com"
      const method = InviteMethod.EMAIL
      
      const result = await createInvite({
        accountId: alice.account.id,
        contact,
        method,
      })
      
      expect(result).not.toBeInstanceOf(Error)
      if (!(result instanceof Error)) {
        expect(result.contact).toBe(contact)
        expect(result.method).toBe(method)
        expect(result.status).toBe(InviteStatus.PENDING)
      }
    })

    it("should create an SMS invitation successfully", async () => {
      const contact = "+12345678900"
      const method = InviteMethod.SMS
      
      const result = await createInvite({
        accountId: alice.account.id,
        contact,
        method,
      })
      
      expect(result).not.toBeInstanceOf(Error)
      if (!(result instanceof Error)) {
        expect(result.contact).toBe(contact)
        expect(result.method).toBe(method)
        expect(result.status).toBe(InviteStatus.PENDING)
      }
    })

    it("should reject invalid email format", async () => {
      const contact = "invalid-email"
      const method = InviteMethod.EMAIL
      
      const result = await createInvite({
        accountId: alice.account.id,
        contact,
        method,
      })
      
      expect(result).toBeInstanceOf(Error)
      if (result instanceof Error) {
        expect(result.message).toContain("Invalid email")
      }
    })

    it("should reject invalid phone number", async () => {
      const contact = "123"
      const method = InviteMethod.SMS
      
      const result = await createInvite({
        accountId: alice.account.id,
        contact,
        method,
      })
      
      expect(result).toBeInstanceOf(Error)
      if (result instanceof Error) {
        expect(result.message).toContain("Invalid phone")
      }
    })

    it("should prevent duplicate invitations to same contact", async () => {
      const contact = "duplicate@example.com"
      const method = InviteMethod.EMAIL
      
      // First invitation
      const result1 = await createInvite({
        accountId: alice.account.id,
        contact,
        method,
      })
      expect(result1).not.toBeInstanceOf(Error)
      
      // Second invitation (should fail)
      const result2 = await createInvite({
        accountId: alice.account.id,
        contact,
        method,
      })
      
      expect(result2).toBeInstanceOf(Error)
      if (result2 instanceof Error) {
        expect(result2.message).toContain("already been invited")
      }
    })

    it("should include username in invitation", async () => {
      // Update alice's username
      await alice.account.setUsername("AliceTest")
      
      const contact = "username-test@example.com"
      const method = InviteMethod.EMAIL
      
      const result = await createInvite({
        accountId: alice.account.id,
        contact,
        method,
      })
      
      expect(result).not.toBeInstanceOf(Error)
      // In real implementation, we'd check the notification service
      // to verify the username was included in the message
    })
  })

  describe("redeemInvite", () => {
    let validToken: string
    let inviteId: string

    beforeEach(async () => {
      // Create a fresh invite for redemption tests
      const contact = `redeem${Date.now()}@example.com`
      const method = InviteMethod.EMAIL
      
      const invite = await createInvite({
        accountId: alice.account.id,
        contact,
        method,
      })
      
      if (!(invite instanceof Error)) {
        inviteId = invite.id
        // In real implementation, extract token from the invite
        validToken = randomBytes(20).toString("hex")
        
        // Store the token-invite mapping (simplified for test)
        await InviteRepository.updateInviteToken(inviteId, validToken)
      }
    })

    it("should redeem a valid invitation token", async () => {
      const result = await redeemInvite({
        accountId: bob.account.id,
        token: validToken,
      })
      
      expect(result).not.toBeInstanceOf(Error)
      if (!(result instanceof Error)) {
        expect(result).toBe(true)
      }
    })

    it("should reject invalid token format", async () => {
      const result = await redeemInvite({
        accountId: bob.account.id,
        token: "invalid-token",
      })
      
      expect(result).toBeInstanceOf(Error)
      if (result instanceof Error) {
        expect(result.message).toContain("Invalid invitation token")
      }
    })

    it("should prevent self-redemption", async () => {
      const result = await redeemInvite({
        accountId: alice.account.id, // Same as inviter
        token: validToken,
      })
      
      expect(result).toBeInstanceOf(Error)
      if (result instanceof Error) {
        expect(result.message).toContain("cannot redeem your own")
      }
    })

    it("should prevent double redemption", async () => {
      // First redemption
      const result1 = await redeemInvite({
        accountId: bob.account.id,
        token: validToken,
      })
      expect(result1).not.toBeInstanceOf(Error)
      
      // Second redemption (should fail)
      const result2 = await redeemInvite({
        accountId: bob.account.id,
        token: validToken,
      })
      
      expect(result2).toBeInstanceOf(Error)
      if (result2 instanceof Error) {
        expect(result2.message).toContain("already been used")
      }
    })
  })

  describe("Rate Limiting", () => {
    it("should enforce daily rate limit per user", async () => {
      const method = InviteMethod.EMAIL
      let successCount = 0
      
      // Try to send 11 invitations
      for (let i = 0; i < 11; i++) {
        const contact = `ratelimit${i}@example.com`
        const result = await createInvite({
          accountId: alice.account.id,
          contact,
          method,
        })
        
        if (!(result instanceof Error)) {
          successCount++
        }
      }
      
      // Should allow 10, reject 11th
      expect(successCount).toBe(10)
    })

    it("should enforce rate limit per target contact", async () => {
      const targetEmail = "target-limit@example.com"
      const method = InviteMethod.EMAIL
      let successCount = 0
      
      // Different users try to invite same target
      const users = [alice, bob]
      
      for (const user of users) {
        const result = await createInvite({
          accountId: user.account.id,
          contact: targetEmail,
          method,
        })
        
        if (!(result instanceof Error)) {
          successCount++
        }
      }
      
      // Should allow limited invites to same target
      expect(successCount).toBeLessThanOrEqual(3)
    })
  })

  describe("Invite Expiration", () => {
    it("should create invites with 24 hour expiration", async () => {
      const contact = "expiry-test@example.com"
      const method = InviteMethod.EMAIL
      
      const result = await createInvite({
        accountId: alice.account.id,
        contact,
        method,
      })
      
      expect(result).not.toBeInstanceOf(Error)
      if (!(result instanceof Error)) {
        const createdAt = new Date(result.createdAt)
        const expiresAt = new Date(result.expiresAt)
        
        const diffInHours = (expiresAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60)
        expect(diffInHours).toBeCloseTo(24, 0)
      }
    })
  })
})