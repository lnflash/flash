import {
  BridgeTransferRequest,
  BridgeTransferRequestStatus,
  BridgeTransferRequestTransactionType,
} from "@services/frappe/models/BridgeTransferRequest"

describe("BridgeTransferRequest", () => {
  it("serializes a topup audit request to ERPNext field names", () => {
    const request = new BridgeTransferRequest({
      requestId: "tr_123",
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.FiatReceived,
      amount: "10.25",
      currency: "usd",
      bridgeCustomerId: "cust_123",
      bridgeTransferId: "tr_123",
      sourceEventId: "wh_123",
      sourceEventType: "deposit.funds_received",
      sourceSystemsSeen: ["bridge_deposit"],
      rawPayload: { event_id: "wh_123" },
    })

    expect(request.toErpnext()).toEqual({
      doctype: "Bridge Transfer Request",
      request_id: "tr_123",
      transaction_type: "Topup",
      status: "Fiat Received",
      provider: "Bridge",
      asset: "USDT",
      network: "Ethereum",
      amount: "10.25",
      currency: "usd",
      developer_fee: undefined,
      initial_amount: undefined,
      subtotal_amount: undefined,
      final_amount: undefined,
      account_id: undefined,
      wallet_id: undefined,
      bridge_customer_id: "cust_123",
      bridge_transfer_id: "tr_123",
      ibex_tx_hash: undefined,
      address: undefined,
      source_event_id: "wh_123",
      source_event_type: "deposit.funds_received",
      source_systems_seen: "bridge_deposit",
      first_seen_at: undefined,
      last_seen_at: expect.any(String),
      raw_payload_json: JSON.stringify({ event_id: "wh_123" }),
      failure_reason: undefined,
    })
  })

  it("serializes source systems without duplicates", () => {
    const request = new BridgeTransferRequest({
      requestId: "ibex:tx-123",
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.Settled,
      amount: "2.500000",
      currency: "USDT",
      sourceSystemsSeen: ["ibex_crypto_receive", "ibex_crypto_receive"],
    })

    expect(request.toErpnext().source_systems_seen).toBe("ibex_crypto_receive")
  })

  it("serializes datetimes in the format accepted by Frappe", () => {
    const request = new BridgeTransferRequest({
      requestId: "tr_123",
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.Settled,
      amount: "2.500000",
      currency: "USDT",
      firstSeenAt: "2026-06-08T20:30:01.373Z",
      lastSeenAt: "2026-06-08T20:31:02.540Z",
    })

    expect(request.toErpnext()).toEqual(
      expect.objectContaining({
        first_seen_at: "2026-06-08 20:30:01",
        last_seen_at: "2026-06-08 20:31:02",
      }),
    )
  })
})
