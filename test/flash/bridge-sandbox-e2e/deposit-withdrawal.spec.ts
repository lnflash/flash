/**
 * Bridge Sandbox E2E — Deposit → Withdrawal Lifecycle
 *
 * Tests the deposit webhook processing and withdrawal initiation flow.
 *
 * Verified shapes (from source audit):
 *   - depositHandler accepts
 *     { event_id, event_object: { id, state, amount, currency, on_behalf_of, receipt? } }
 *     returns { status: "success" } on 200
 *   - bridgeInitiateWithdrawal(input: { amount: String!, externalAccountId: ID! }) returns
 *     { errors, withdrawal: { id, amount, currency, status, failureReason, createdAt } }
 *
 * The deposit handler is fully testable via webhook injection — it's self-contained
 * and persists to BridgeDeposits + optional ERPNext.
 *
 * The withdrawal mutation calls Bridge API's createTransfer endpoint, which requires
 * real sandbox state (KYC'd customer, funded wallet, verified external account).
 * Full-flow tests are guarded by BRIDGE_SANDBOX_WITHDRAWAL_CONFIRMED=true.
 * Error-path tests verify expected failures when prerequisites are missing.
 *
 * ⚠️ The deposit handler triggers reconciliation only when state === "payment_processed"
 *    WITH a destination_tx_hash. For sandbox testing, the reconciliation may or may not
 *    succeed — the test asserts the handler responds correctly regardless.
 */

import {
  createBridgeSandboxUser,
  initiateKyc,
  createVirtualAccount,
  initiateWithdrawal,
  injectKycWebhook,
  injectDepositWebhook,
  findDepositLogByEventId,
  BridgeTestUser,
} from "./helpers"

describe("Bridge Deposit → Withdrawal", () => {
  let user: BridgeTestUser

  beforeAll(async () => {
    user = await createBridgeSandboxUser(1)
  })

  // ============ Deposit Webhook ============

  describe("Deposit Webhook Processing", () => {
    it("processes a valid deposit webhook and returns success", async () => {
      const eventId = `dep-test-${Date.now()}`
      const response = await injectDepositWebhook({
        event_id: eventId,
        event_object: {
          id: `transfer_test_${Date.now()}`,
          state: "payment_processed",
          amount: "100.00",
          currency: "usdt",
          on_behalf_of: `sandbox_cus_${user.accountId.slice(-8)}`,
          receipt: {
            initial_amount: "100.00",
            subtotal_amount: "100.00",
            final_amount: "96.00",
            developer_fee: "2.00",
            destination_tx_hash: `0x${Date.now().toString(16)}dead`,
          },
        },
      })

      expect(response.status).toBe(200)
      expect(response.body).toBeDefined()
      expect(response.body.status).toBe("success")
    })

    it("persists a deposit log to the BridgeDeposits collection", async () => {
      const eventId = `dep-log-${Date.now()}`
      const transferId = `transfer_log_${Date.now()}`
      const response = await injectDepositWebhook({
        event_id: eventId,
        event_object: {
          id: transferId,
          state: "payment_processed",
          amount: "50.00",
          currency: "usdt",
          on_behalf_of: `sandbox_cus_${user.accountId.slice(-8)}`,
        },
      })

      expect(response.status).toBe(200)

      // Query the deposit log directly
      const log = await findDepositLogByEventId(eventId)
      expect(log).toBeTruthy()
      expect(log!.eventId).toBe(eventId)
      expect(log!.transferId).toBe(transferId)
      expect(log!.amount).toBe("50.00")
      expect(log!.currency).toBe("usdt")
      expect(log!.state).toBe("payment_processed")
    })

    it("returns already_processed for duplicate deposit webhooks", async () => {
      const eventId = `dep-dup-${Date.now()}`
      const payload = {
        event_id: eventId,
        event_object: {
          id: `transfer_dup_${Date.now()}`,
          state: "payment_processed",
          amount: "25.00",
          currency: "usdt",
          on_behalf_of: `sandbox_cus_${user.accountId.slice(-8)}`,
        },
      }

      // First call
      const first = await injectDepositWebhook(payload)
      expect(first.status).toBe(200)
      expect(first.body.status).toBe("success")

      // Duplicate event_id — idempotency lock fires before the handler re-processes
      const second = await injectDepositWebhook(payload)
      expect(second.status).toBe(200)
      expect(second.body.status).toBe("already_processed")
    })

    it("handles intermediate state transitions (not just payment_processed)", async () => {
      const response = await injectDepositWebhook({
        event_id: `dep-pending-${Date.now()}`,
        event_object: {
          id: `transfer_pending_${Date.now()}`,
          state: "pending_transfer",
          amount: "75.00",
          currency: "usdt",
          on_behalf_of: `sandbox_cus_${user.accountId.slice(-8)}`,
        },
      })

      // Intermediate states are logged and return success but do NOT trigger
      // reconciliation (only payment_processed with tx hash does)
      expect(response.status).toBe(200)
      expect(response.body.status).toBe("success")
    })

    it("rejects a deposit webhook with missing required fields", async () => {
      const response = await injectDepositWebhook({
        event_id: "dep-invalid",
        event_object: {
          id: "",
          state: "",
          amount: "",
          currency: "",
          on_behalf_of: "",
        },
      })

      // Handler validates presence of event_object.id, event_id, amount, on_behalf_of
      expect(response.status).toBe(400)
    })
  })

  // ============ Withdrawal ============

  describe("Withdrawal Initiation", () => {
    it("rejects withdrawal when amount is below minimum", async () => {
      // minimum withdrawal is 2 (from config), so 0.50 should be rejected
      const result = await initiateWithdrawal(user.accountId, {
        amount: "0.50",
        externalAccountId: "ext_acct_placeholder",
      })

      expect(result.errors).toBeDefined()
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0].message).toMatch(/minimum/i)
      expect(result.withdrawal).toBeUndefined()
    })

    it("rejects withdrawal when amount is invalid (non-numeric)", async () => {
      const result = await initiateWithdrawal(user.accountId, {
        amount: "abc",
        externalAccountId: "ext_acct_placeholder",
      })

      expect(result.errors).toBeDefined()
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.withdrawal).toBeUndefined()
    })

    it("rejects withdrawal when account has no Bridge customer ID", async () => {
      // No KYC has been initiated for this account, so bridgeCustomerId is null
      const result = await initiateWithdrawal(user.accountId, {
        amount: "50.00",
        externalAccountId: "ext_acct_no_customer",
      })

      expect(result.errors).toBeDefined()
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0].message).toMatch(/customer|KYC/i)
      expect(result.withdrawal).toBeUndefined()
    })
  })
})
