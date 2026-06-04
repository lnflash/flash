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
})
