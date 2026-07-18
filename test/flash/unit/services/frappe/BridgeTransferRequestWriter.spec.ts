jest.mock("@services/frappe/ErpNext", () => ({
  upsertBridgeTransferRequest: jest.fn(),
  hasBridgeTransferRequest: jest.fn(),
  completeBridgeTopupByTxHash: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

import ErpNext from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"
import {
  promoteBridgeDepositForCryptoReceive,
  writeBridgeCashoutCompleted,
  writeBridgeCashoutFailed,
  writeBridgeCashoutPending,
  writeBridgeDepositRequest,
  writeIbexCryptoReceiveRequest,
} from "@services/frappe/BridgeTransferRequestWriter"
import { BridgeTransferRequestStatus } from "@services/frappe/models/BridgeTransferRequest"

const upsert = ErpNext.upsertBridgeTransferRequest as jest.Mock
const hasRow = ErpNext.hasBridgeTransferRequest as jest.Mock
const completeByTxHash = ErpNext.completeBridgeTopupByTxHash as jest.Mock
const lastRequestInput = () => upsert.mock.calls[0][0].input

describe("BridgeTransferRequestWriter", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    upsert.mockResolvedValue(true)
    hasRow.mockResolvedValue(false)
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
    expect(hasRow).toHaveBeenCalledWith("ibex:tx_123")
  })

  it("writes the deposit as Completed when the IBEX settle row already exists", async () => {
    hasRow.mockResolvedValue(true)

    await writeBridgeDepositRequest({
      eventId: "wh_123",
      eventObject: {
        id: "tr_123",
        state: "payment_processed",
        amount: "10.00",
        currency: "usd",
        on_behalf_of: "cust_123",
        receipt: { destination_tx_hash: "tx_123" },
      },
      rawPayload: { event_id: "wh_123" },
    })

    expect(lastRequestInput()).toEqual(
      expect.objectContaining({
        requestId: "tr_123",
        status: BridgeTransferRequestStatus.Completed,
        sourceSystemsSeen: ["bridge_deposit", "ibex_crypto_receive"],
      }),
    )
  })

  it("does not check for a settle row when the deposit has no destination tx hash", async () => {
    await writeBridgeDepositRequest({
      eventId: "wh_123",
      eventObject: {
        id: "tr_123",
        state: "funds_received",
        amount: "10.00",
        currency: "usd",
        on_behalf_of: "cust_123",
      },
      rawPayload: { event_id: "wh_123" },
    })

    expect(hasRow).not.toHaveBeenCalled()
    expect(lastRequestInput()).toEqual(
      expect.objectContaining({ status: BridgeTransferRequestStatus.FiatReceived }),
    )
  })

  it("falls back to Fiat Received when the settle-row check fails", async () => {
    hasRow.mockResolvedValue(new Error("erpnext down"))

    await writeBridgeDepositRequest({
      eventId: "wh_123",
      eventObject: {
        id: "tr_123",
        state: "payment_processed",
        amount: "10.00",
        currency: "usd",
        on_behalf_of: "cust_123",
        receipt: { destination_tx_hash: "tx_123" },
      },
      rawPayload: { event_id: "wh_123" },
    })

    expect(lastRequestInput()).toEqual(
      expect.objectContaining({ status: BridgeTransferRequestStatus.FiatReceived }),
    )
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "tx_123" }),
      "Failed to check IBEX settle row for Bridge deposit; keeping Fiat Received",
    )
  })

  it("promotes the deposit row via ErpNext on crypto receive", async () => {
    completeByTxHash.mockResolvedValue("completed")

    const result = await promoteBridgeDepositForCryptoReceive({
      txHash: "tx_123",
      accountId: "acct_123" as AccountId,
      walletId: "wallet_123" as WalletId,
    })

    expect(result).toBe("completed")
    expect(completeByTxHash).toHaveBeenCalledWith({
      txHash: "tx_123",
      accountId: "acct_123",
      walletId: "wallet_123",
    })
  })

  it("skips virtual account activity until Bridge provides a stable deposit id", async () => {
    await writeBridgeDepositRequest({
      eventId: "wh_scheduled",
      eventObject: {
        id: "activity_123",
        type: "funds_scheduled",
        amount: "10.00",
        currency: "usd",
        on_behalf_of: "cust_123",
        customer_id: "cust_123",
        virtual_account_id: "va_123",
        product_type: "virtual_account",
      },
      rawPayload: { event_id: "wh_scheduled" },
    })

    expect(upsert).not.toHaveBeenCalled()
    expect(baseLogger.warn).toHaveBeenCalledWith(
      {
        eventId: "wh_scheduled",
        bridgeEventObjectId: "activity_123",
        state: "funds_scheduled",
      },
      "Skipping Bridge deposit ERPNext audit row without stable request id",
    )
  })

  it("does not use destination payment rail as a deposit currency fallback", async () => {
    await writeBridgeDepositRequest({
      eventId: "wh_rail",
      eventObject: {
        id: "tr_rail",
        state: "funds_received",
        amount: "10.00",
        currency: undefined as unknown as string,
        destination_payment_rail: "wire",
        on_behalf_of: "cust_123",
      },
      rawPayload: { event_id: "wh_rail" },
    })

    expect(lastRequestInput()).toEqual(
      expect.objectContaining({
        currency: "usd",
      }),
    )
  })

  it("keys virtual account deposits by Bridge deposit id", async () => {
    await writeBridgeDepositRequest({
      eventId: "wh_received",
      eventObject: {
        id: "activity_456",
        type: "funds_received",
        amount: "10.00",
        currency: "usd",
        on_behalf_of: "cust_123",
        customer_id: "cust_123",
        deposit_id: "deposit_123",
        virtual_account_id: "va_123",
        product_type: "virtual_account",
      },
      rawPayload: { event_id: "wh_received" },
    })

    expect(lastRequestInput()).toEqual(
      expect.objectContaining({
        requestId: "deposit_123",
        bridgeTransferId: "deposit_123",
        sourceEventId: "wh_received",
        sourceEventType: "deposit.funds_received",
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
