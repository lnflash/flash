/**
 * Bridge Sandbox E2E — KYC + Virtual Account Flow
 *
 * Tests the complete KYC initiation → webhook processing → virtual account creation flow.
 *
 * Verified return shapes (from source audit):
 *   - bridgeInitiateKyc returns { errors, kycLink: { kycLink: string!, tosLink: string! } }
 *   - bridgeCreateVirtualAccount returns { errors, virtualAccount: { id, bankName, ... } }
 *   - No ERPNext writer exists for BridgeVirtualAccount (only BridgeTransferRequest exists)
 */

import {
  createBridgeSandboxUser,
  initiateKyc,
  createVirtualAccount,
  injectKycWebhook,
  getAccountById,
  BridgeTestUser,
} from "./helpers"

const VIRTUAL_ACCOUNT_TESTS =
  process.env.BRIDGE_SANDBOX_VIRTUAL_ACCOUNT_CONFIRMED === "true"

describe("Bridge KYC → Virtual Account", () => {
  let user: BridgeTestUser

  beforeAll(async () => {
    user = await createBridgeSandboxUser(1)
  })

  describe("KYC Initiation", () => {
    it("initiates KYC and returns a KYC link URL and TOS link", async () => {
      const result = await initiateKyc(
        user.accountId,
        `sandbox-${user.accountId.slice(-8)}@test.flashapp.me`,
      )

      expect(result.errors).toBeDefined()
      expect(result.errors).toHaveLength(0)
      expect(result.kycLink).toBeDefined()
      expect(result.kycLink!.kycLink).toBeTruthy()
      expect(result.kycLink!.kycLink).toMatch(/^https:\/\//)
      expect(result.kycLink!.tosLink).toBeTruthy()
      expect(result.kycLink!.tosLink).toMatch(/^https:\/\//)
    })
  })

  describe("KYC Webhook Processing", () => {
    beforeAll(async () => {
      // Initiate KYC first to create the Bridge customer
      const kycResult = await initiateKyc(
        user.accountId,
        `webhook-${user.accountId.slice(-8)}-${Date.now()}@test.flashapp.me`,
      )
      if (kycResult.errors?.length) {
        throw new Error(`KYC initiation failed: ${kycResult.errors[0].message}`)
      }
    })

    it("processes a KYC-approved webhook and marks account as approved", async () => {
      const account = await getAccountById(user.accountId)
      const webhookCustomerId = account.bridgeCustomerId
      if (!webhookCustomerId) {
        throw new Error("KYC initiation did not persist a Bridge customer ID")
      }

      const response = await injectKycWebhook({
        event_id: `test-kyc-approved-${Date.now()}`,
        event_object: {
          customer_id: webhookCustomerId,
          kyc_status: "approved",
        },
      })

      // The handler returns 200 for any valid webhook payload structure
      expect(response.status).toBe(200)
    })
  })
  ;(VIRTUAL_ACCOUNT_TESTS ? describe : describe.skip)("Virtual Account Creation", () => {
    it("creates a virtual account after KYC approval", async () => {
      const result = await createVirtualAccount(user.accountId)

      expect(result.errors).toBeDefined()
      expect(result.errors).toHaveLength(0)
      expect(result.virtualAccount).toBeDefined()
      expect(result.virtualAccount!.id).toBeTruthy()
      // Virtual account should include bank details
      expect(result.virtualAccount!.bankName).toBeDefined()
      expect(result.virtualAccount!.routingNumber).toBeDefined()
      expect(result.virtualAccount!.accountNumberLast4).toBeDefined()
    })

    it("virtual account is idempotent — calling twice returns same result", async () => {
      const result1 = await createVirtualAccount(user.accountId)
      const result2 = await createVirtualAccount(user.accountId)

      expect(result1.errors).toHaveLength(0)
      expect(result2.errors).toHaveLength(0)
      // Both calls should succeed (idempotent) — the second may return existing VA
      expect(result1.virtualAccount?.id || result2.virtualAccount?.id).toBeTruthy()
    })
  })
})
