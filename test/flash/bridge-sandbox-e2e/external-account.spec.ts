/**
 * Bridge Sandbox E2E — External Account (Plaid) Flow
 *
 * Tests the `bridgeAddExternalAccount` mutation and external-account
 * webhook handling.
 *
 * Verified shapes (from source audit):
 *   - bridgeAddExternalAccount returns
 *     { errors, externalAccount: { linkUrl: string!, expiresAt: string! } }
 *   - externalAccountHandler accepts
 *     { event_id, event_object: { id, customer_id, bank_name, last_4, active } }
 *     and returns { status: "success" } or { status: "already_processed" } on 200
 *
 * ⚠️ Plaid sandbox linking is a manual step — the test generates the link URL
 *    and verifies it's well-formed, then simulates the webhook that follows
 *    successful Plaid linking. The test does NOT automate the Plaid browser UI.
 *
 * ⚠️ Some sandboxes return "link_url" instead of "linkUrl" — check actual response
 *    against the configured return shape and update assertions if needed.
 */

import {
  createBridgeSandboxUser,
  initiateKyc,
  addExternalAccount,
  injectKycWebhook,
  injectExternalAccountWebhook,
  getAccountById,
  BridgeTestUser,
} from "./helpers"

const EXTERNAL_ACCOUNT_LINK_TESTS =
  process.env.BRIDGE_SANDBOX_EXTERNAL_ACCOUNT_LINK_CONFIRMED === "true"

describe("Bridge External Account", () => {
  let user: BridgeTestUser

  beforeAll(async () => {
    user = await createBridgeSandboxUser(1)

    // === Prerequisites: KYC + Virtual Account ===
    const kycResult = await initiateKyc(
      user.accountId,
      `ext-acct-${user.accountId.slice(-8)}-${Date.now()}@test.flashapp.me`,
    )
    if (kycResult.errors?.length) {
      throw new Error(`KYC initiation failed: ${kycResult.errors[0].message}`)
    }

    // Approve KYC via webhook injection using the customer ID persisted by KYC initiation.
    const account = await getAccountById(user.accountId)
    const webhookCustomerId = account.bridgeCustomerId
    if (!webhookCustomerId) {
      throw new Error("KYC initiation did not persist a Bridge customer ID")
    }
    user.customerId = webhookCustomerId
    const webhookResult = await injectKycWebhook({
      event_id: `ext-acct-kyc-${Date.now()}`,
      event_object: { customer_id: webhookCustomerId, kyc_status: "approved" },
    })
    if (webhookResult.status !== 200) {
      throw new Error(`KYC webhook failed with status ${webhookResult.status}`)
    }
  })
  ;(EXTERNAL_ACCOUNT_LINK_TESTS ? describe : describe.skip)(
    "Plaid Link URL Generation",
    () => {
      it("generates a Plaid link URL when called", async () => {
        const result = await addExternalAccount(user.accountId)

        expect(result.errors).toBeDefined()
        expect(result.errors).toHaveLength(0)
        expect(result.externalAccount).toBeDefined()
        expect(result.externalAccount!.linkUrl).toBeTruthy()
        expect(result.externalAccount!.linkUrl).toMatch(/^https:\/\//)
        expect(result.externalAccount!.expiresAt).toBeTruthy()
      })

      it("link URL is different on each call (one-time use tokens)", async () => {
        const result1 = await addExternalAccount(user.accountId)
        const result2 = await addExternalAccount(user.accountId)

        expect(result1.errors).toHaveLength(0)
        expect(result2.errors).toHaveLength(0)

        // Plaid link tokens are one-time use; consecutive calls should differ
        expect(result1.externalAccount?.linkUrl).toBeTruthy()
        expect(result2.externalAccount?.linkUrl).toBeTruthy()
        expect(result1.externalAccount!.linkUrl).not.toBe(
          result2.externalAccount!.linkUrl,
        )
      })
    },
  )

  describe("External Account Webhook Processing", () => {
    it("processes a valid external-account webhook and returns success", async () => {
      // This simulates what Bridge sends after a user completes the Plaid flow
      const response = await injectExternalAccountWebhook({
        event_id: `ext-created-${Date.now()}`,
        event_object: {
          id: `ext_acct_test_${Date.now()}`,
          customer_id: user.customerId!,
          bank_name: "Test Bank",
          last_4: "1234",
          active: true,
        },
      })

      expect(response.status).toBe(200)
      expect(response.body).toBeDefined()
      expect(response.body.status).toBe("success")
    })

    it("returns already_processed for duplicate external-account webhooks", async () => {
      const eventId = `ext-duplicate-${Date.now()}`
      const payload = {
        event_id: eventId,
        event_object: {
          id: `ext_acct_dup_${Date.now()}`,
          customer_id: user.customerId!,
          bank_name: "Test Bank",
          last_4: "9999",
          active: true,
        },
      }

      // First call — should succeed
      const first = await injectExternalAccountWebhook(payload)
      expect(first.status).toBe(200)
      expect(first.body.status).toBe("success")

      // Second call with same event_id — idempotency lock
      const second = await injectExternalAccountWebhook(payload)
      expect(second.status).toBe(200)
      expect(second.body.status).toBe("already_processed")
    })

    it("rejects a webhook with missing customer_id", async () => {
      const response = await injectExternalAccountWebhook({
        event_id: `ext-missing-${Date.now()}`,
        event_object: {
          id: "ext_acct_missing_cus",
          customer_id: "",
          bank_name: "No Customer",
          last_4: "0000",
          active: true,
        },
      })

      // Handler validates customer_id presence — returns 400 or 503 depending
      // on whether it fails the initial guard (400) or the account lookup (503)
      expect(response.status).toBeGreaterThanOrEqual(400)
    })
  })
})
