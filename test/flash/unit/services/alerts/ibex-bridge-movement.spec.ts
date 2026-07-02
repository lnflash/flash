jest.mock("@services/alerts", () => ({
  alertBridge: jest.fn(),
}))

import { alertBridge } from "@services/alerts"
import {
  alertIbexCryptoReceiveFailure,
  alertIbexReconciliationOrphan,
} from "@services/alerts/ibex-bridge-movement"

describe("ibex bridge movement alerts", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("routes crypto receive failures as IBEX warnings", () => {
    alertIbexCryptoReceiveFailure({
      txHash: "0xabc",
      code: "erpnext_audit_failed",
      title: "IBEX crypto receive ERPNext audit write failed",
      detail: "timeout",
      context: { accountId: "acc_1" },
    })

    expect(alertBridge).toHaveBeenCalledWith({
      dedupKey: "ibex:crypto-receive:0xabc",
      source: "ibex",
      severity: "warning",
      title: "IBEX crypto receive ERPNext audit write failed",
      detail: "timeout",
      context: {
        tx_hash: "0xabc",
        code: "erpnext_audit_failed",
        accountId: "acc_1",
      },
    })
  })

  it("routes reconciliation orphans as IBEX warnings", () => {
    alertIbexReconciliationOrphan({
      orphanType: "ibex_without_bridge",
      txHash: "0xdef",
      reason: "No Bridge deposit payment_processed found for IBEX tx hash within window",
    })

    expect(alertBridge).toHaveBeenCalledWith({
      dedupKey: "ibex:reconcile:ibex-without-bridge:0xdef",
      source: "ibex",
      severity: "warning",
      title: "IBEX crypto receive without matching Bridge deposit",
      detail: "No Bridge deposit payment_processed found for IBEX tx hash within window",
      context: {
        orphan_type: "ibex_without_bridge",
        tx_hash: "0xdef",
        transfer_id: undefined,
      },
    })
  })
})
