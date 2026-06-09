import {
  generateDedupKey,
  informDedupTtlMs,
  normalizeDedupKey,
} from "@services/alerts/dedup-key"

describe("generateDedupKey", () => {
  it("uses coarse keys for Bridge API outage classes", () => {
    expect(generateDedupKey.bridgeApi5xx()).toBe("bridge-api:5xx")
    expect(generateDedupKey.bridgeApiTimeout()).toBe("bridge-api:timeout")
    expect(generateDedupKey.bridgeApiNetwork()).toBe("bridge-api:network")
  })

  it("scopes ERPNext and webhook keys per resource", () => {
    expect(generateDedupKey.erpnextDepositAudit("tr_1")).toBe(
      "erpnext-audit:deposit:tr_1",
    )
    expect(generateDedupKey.erpnextTransferCompletedAudit("tr_2")).toBe(
      "erpnext-audit:transfer-complete:tr_2",
    )
    expect(generateDedupKey.bridgeWebhookDeposit("wh_1")).toBe(
      "bridge-webhook:deposit:wh_1",
    )
    expect(generateDedupKey.bridgeWebhookTransfer("tr_3", "transfer.completed")).toBe(
      "bridge-webhook:transfer:tr_3:transfer.completed",
    )
  })

  it("scopes IBEX Bridge movement keys per tx hash or transfer", () => {
    expect(generateDedupKey.ibexCryptoReceive("0XABC")).toBe("ibex:crypto-receive:0xabc")
    expect(generateDedupKey.ibexReconcileBridgeWithoutIbex("0xabc")).toBe(
      "ibex:reconcile:bridge-without-ibex:0xabc",
    )
    expect(generateDedupKey.ibexReconcileIbexWithoutBridge("0xabc")).toBe(
      "ibex:reconcile:ibex-without-bridge:0xabc",
    )
    expect(generateDedupKey.ibexReconcileBridgeWithoutIbexTransfer("tr_1")).toBe(
      "ibex:reconcile:bridge-without-ibex:transfer:tr_1",
    )
  })
})

describe("informDedupTtlMs", () => {
  it("uses a shorter TTL for Bridge API outage keys", () => {
    expect(informDedupTtlMs("bridge-api:5xx")).toBe(30 * 60 * 1000)
    expect(informDedupTtlMs("erpnext-audit:deposit:tr_1")).toBe(60 * 60 * 1000)
  })
})

describe("normalizeDedupKey", () => {
  it("truncates keys to PagerDuty's maximum dedup_key length", () => {
    expect(normalizeDedupKey("a".repeat(300))).toHaveLength(255)
  })
})
