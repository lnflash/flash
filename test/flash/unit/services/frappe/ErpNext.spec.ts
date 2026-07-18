jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  isAxiosError: jest.fn((err) => Boolean(err?.isAxiosError)),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@config", () => ({
  FrappeConfig: undefined,
}))

import axios from "axios"
import { ErpNext } from "@services/frappe/ErpNext"
import {
  BridgeTransferRequest,
  BridgeTransferRequestStatus,
  BridgeTransferRequestTransactionType,
} from "@services/frappe/models/BridgeTransferRequest"

const mockedAxios = axios as unknown as {
  get: jest.Mock
  post: jest.Mock
  put: jest.Mock
}

const client = new ErpNext("https://erp.example", "erp.example", {
  apiKey: "key",
  apiSecret: "secret",
})

const request = new BridgeTransferRequest({
  requestId: "tr_123",
  transactionType: BridgeTransferRequestTransactionType.Topup,
  status: BridgeTransferRequestStatus.FiatReceived,
  amount: "10.00",
  currency: "usd",
})

describe("ErpNext.upsertBridgeTransferRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("creates a Bridge Transfer Request when request_id is absent", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })
    mockedAxios.post.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const result = await client.upsertBridgeTransferRequest(request)

    expect(result).toBe(true)
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bridge Transfer Request",
      expect.objectContaining({ request_id: "tr_123" }),
      expect.any(Object),
    )
    expect(mockedAxios.put).not.toHaveBeenCalled()
  })

  it("updates a Bridge Transfer Request when request_id already exists", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ name: "BTR-1" }] } })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const result = await client.upsertBridgeTransferRequest(request)

    expect(result).toBe(true)
    expect(mockedAxios.post).not.toHaveBeenCalled()
    expect(mockedAxios.put).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bridge%20Transfer%20Request/BTR-1",
      expect.objectContaining({ request_id: "tr_123" }),
      expect.any(Object),
    )
  })

  it("never downgrades a promoted Topup row's status", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.Completed,
            source_systems_seen: "bridge_deposit,ibex_crypto_receive",
          },
        ],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const result = await client.upsertBridgeTransferRequest(request)

    expect(result).toBe(true)
    expect(mockedAxios.put).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bridge%20Transfer%20Request/BTR-1",
      expect.objectContaining({
        status: BridgeTransferRequestStatus.Completed,
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
      }),
      expect.any(Object),
    )
  })

  it("allows a Topup row's status to move forward", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.FiatReceived,
            source_systems_seen: "bridge_deposit",
          },
        ],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const completedRequest = new BridgeTransferRequest({
      requestId: "tr_123",
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.Completed,
      amount: "10.00",
      currency: "usd",
      sourceSystemsSeen: ["bridge_deposit", "ibex_crypto_receive"],
    })
    const result = await client.upsertBridgeTransferRequest(completedRequest)

    expect(result).toBe(true)
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: BridgeTransferRequestStatus.Completed,
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
      }),
      expect.any(Object),
    )
  })

  it("merges source_systems_seen instead of overwriting on update", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.Completed,
            source_systems_seen: "bridge_deposit,ibex_crypto_receive",
          },
        ],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    await client.upsertBridgeTransferRequest(request)

    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
      }),
      expect.any(Object),
    )
  })

  it("keeps last-write-wins semantics for Cashout rows", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ name: "BTR-2", status: BridgeTransferRequestStatus.Completed }],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-2" } } })

    const failedCashout = new BridgeTransferRequest({
      requestId: "tr_cashout",
      transactionType: BridgeTransferRequestTransactionType.Cashout,
      status: BridgeTransferRequestStatus.Failed,
      amount: "5.00",
      currency: "usdt",
    })
    await client.upsertBridgeTransferRequest(failedCashout)

    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: BridgeTransferRequestStatus.Failed }),
      expect.any(Object),
    )
  })
})

describe("ErpNext.hasBridgeTransferRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns true when a row with the request_id exists", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ name: "BTR-1" }] } })

    await expect(client.hasBridgeTransferRequest("ibex:tx_123")).resolves.toBe(true)
  })

  it("returns false when no row exists", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    await expect(client.hasBridgeTransferRequest("ibex:tx_123")).resolves.toBe(false)
  })

  it("returns an error when the lookup fails", async () => {
    mockedAxios.get.mockRejectedValue(new Error("network down"))

    const result = await client.hasBridgeTransferRequest("ibex:tx_123")
    expect(result).toBeInstanceOf(Error)
  })
})

describe("ErpNext.completeBridgeTopupByTxHash", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("promotes the matching deposit row to Completed with account attribution", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.FiatReceived,
            source_systems_seen: "bridge_deposit",
          },
        ],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const result = await client.completeBridgeTopupByTxHash({
      txHash: "tx_123",
      accountId: "acct_123",
      walletId: "wallet_123",
    })

    expect(result).toBe("completed")
    const getParams = mockedAxios.get.mock.calls[0][1].params
    expect(JSON.parse(getParams.filters)).toEqual([
      ["Bridge Transfer Request", "ibex_tx_hash", "=", "tx_123"],
      ["Bridge Transfer Request", "transaction_type", "=", "Topup"],
      ["Bridge Transfer Request", "request_id", "not like", "ibex:%"],
    ])
    expect(mockedAxios.put).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bridge%20Transfer%20Request/BTR-1",
      expect.objectContaining({
        status: BridgeTransferRequestStatus.Completed,
        account_id: "acct_123",
        wallet_id: "wallet_123",
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
        last_seen_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      }),
      expect.any(Object),
    )
  })

  it("returns not_found when no deposit row carries the tx hash", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    const result = await client.completeBridgeTopupByTxHash({ txHash: "tx_123" })

    expect(result).toBe("not_found")
    expect(mockedAxios.put).not.toHaveBeenCalled()
  })

  it("is idempotent when the deposit row is already Completed", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ name: "BTR-1", status: BridgeTransferRequestStatus.Completed }],
      },
    })

    const result = await client.completeBridgeTopupByTxHash({ txHash: "tx_123" })

    expect(result).toBe("already_completed")
    expect(mockedAxios.put).not.toHaveBeenCalled()
  })

  it("returns an error when the promotion write fails", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ name: "BTR-1", status: BridgeTransferRequestStatus.FiatReceived }],
      },
    })
    mockedAxios.put.mockRejectedValue(new Error("erpnext down"))

    const result = await client.completeBridgeTopupByTxHash({ txHash: "tx_123" })

    expect(result).toBeInstanceOf(Error)
  })
})
