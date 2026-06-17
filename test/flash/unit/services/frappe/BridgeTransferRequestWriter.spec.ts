jest.mock("@services/frappe/ErpNext", () => ({
  upsertBridgeTransferRequest: jest.fn(),
}))

import ErpNext from "@services/frappe/ErpNext"
import {
  writeBridgeCashoutCompleted,
  writeBridgeCashoutFailed,
  writeBridgeCashoutPending,
  writeBridgeDepositRequest,
  writeIbexCryptoReceiveRequest,
} from "@services/frappe/BridgeTransferRequestWriter"
import { BridgeTransferRequestStatus } from "@services/frappe/models/BridgeTransferRequest"

const upsert = ErpNext.upsertBridgeTransferRequest as jest.Mock
const lastRequestInput = () => upsert.mock.calls[0][0].input

describe("BridgeTransferRequestWriter", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    upsert.mockResolvedValue(true)
  })

  it("writes Bridge deposit events as topup audit requests", async () => {
    await writeBridgeDepositRequest({
      eventId: "wh_123",
      eventObject: {
        id: "tr_123",
        state: "funds_received",
        amount: "10.00",
        currency: "usd",
        on_behalf_of: "cust_123",
        receipt: {
          developer_fee: "0.05",
          initial_amount: "10.00",
          subtotal_amount: "9.95",
          final_amount: "9.95",
          destination_tx_hash: "tx_123",
        },
      },
      rawPayload: { event_id: "wh_123" },
    })

    expect(lastRequestInput()).toEqual(
      expect.objectContaining({
        requestId: "tr_123",
        status: BridgeTransferRequestStatus.FiatReceived,
        bridgeCustomerId: "cust_123",
        bridgeTransferId: "tr_123",
        ibexTxHash: "tx_123",
      }),
    )
  })

  it("writes IBEX crypto receives as settled topup audit requests", async () => {
    await writeIbexCryptoReceiveRequest({
      txHash: "tx_123",
      address: "0xabc",
      amount: "4.250000",
      currency: "USDT",
      network: "ethereum",
      accountId: "acct_123" as AccountId,
      walletId: "wallet_123" as WalletId,
      rawPayload: { tx_hash: "tx_123" },
    })

    expect(lastRequestInput()).toEqual(
      expect.objectContaining({
        requestId: "ibex:tx_123",
        status: BridgeTransferRequestStatus.Settled,
        accountId: "acct_123",
        walletId: "wallet_123",
      }),
    )
  })

  it("writes completed Bridge transfers as completed cashout audit requests", async () => {
    await writeBridgeCashoutCompleted({
      transferId: "tr_cashout",
      amount: "5.00",
      currency: "usdt",
      accountId: "acct_123" as AccountId,
      sourceEventType: "transfer.completed",
      rawPayload: { event: "transfer.completed" },
    })

    expect(lastRequestInput()).toEqual(
      expect.objectContaining({
        requestId: "tr_cashout",
        status: BridgeTransferRequestStatus.Completed,
        accountId: "acct_123",
      }),
    )
  })

  it("writes pending Bridge transfers as pending cashout audit requests", async () => {
    await writeBridgeCashoutPending({
      transferId: "tr_cashout",
      amount: "5.00",
      currency: "usdt",
      accountId: "acct_123" as AccountId,
      sourceEventId: "withdrawal_123",
      sourceEventType: "bridge.withdrawal.usdt_sent",
      rawPayload: { bridgeTransferId: "tr_cashout" },
    })

    expect(lastRequestInput()).toEqual(
      expect.objectContaining({
        requestId: "tr_cashout",
        status: BridgeTransferRequestStatus.Pending,
        accountId: "acct_123",
        sourceEventId: "withdrawal_123",
        sourceEventType: "bridge.withdrawal.usdt_sent",
      }),
    )
  })

  it("writes failed Bridge transfers as failed cashout audit requests", async () => {
    await writeBridgeCashoutFailed({
      transferId: "tr_cashout",
      amount: "5.00",
      currency: "usdt",
      accountId: "acct_123" as AccountId,
      failureReason: "ACH returned",
      sourceEventType: "transfer.failed",
      rawPayload: { event: "transfer.failed" },
    })

    expect(lastRequestInput()).toEqual(
      expect.objectContaining({
        requestId: "tr_cashout",
        status: BridgeTransferRequestStatus.Failed,
        failureReason: "ACH returned",
      }),
    )
  })
})
