// ENG-889: the Cashout draft carries the risk remarks, and the recent Bridge
// deposit read asks ERPNext for the right rows.
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
import { BridgeDepositHistoryQueryError } from "@services/frappe/errors"
import { USDAmount } from "@domain/shared"
import type ValidOffer from "@app/offers/ValidOffer"

const mockedAxios = axios as unknown as { get: jest.Mock; post: jest.Mock }

const client = new ErpNext("https://erp.example", "erp.example", {
  apiKey: "key",
  apiSecret: "secret",
})

const makeOffer = () => {
  const amount = USDAmount.cents("48000")
  if (amount instanceof Error) throw amount
  return {
    account: { erpParty: "Taedo Biggs" },
    details: {
      payment: {
        userAcct: "wallet-1",
        flashAcct: "flash-1",
        invoice: { paymentHash: "hash-1" },
        amount,
      },
      payout: { bankAccountId: "bank-1", amount, serviceFee: amount },
    },
  } as unknown as ValidOffer
}

describe("ErpNext.draftCashout remarks", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAxios.post.mockResolvedValue({ data: { data: { name: "ACC-CSH-1" } } })
  })

  it("sends the risk remarks on the Cashout create call", async () => {
    const remarks = "Risk signals (flag only, nothing was blocked):\nAccount age: 2 days"
    const result = await client.draftCashout(makeOffer(), { remarks })

    expect(result).toBe("ACC-CSH-1")
    const [url, body] = mockedAxios.post.mock.calls[0]
    expect(url).toBe("https://erp.example/api/resource/Cashout")
    expect(body).toMatchObject({ customer: "Taedo Biggs", remarks })
  })

  it("leaves remarks unset when there are none", async () => {
    await client.draftCashout(makeOffer())

    expect(mockedAxios.post.mock.calls[0][1].remarks).toBeUndefined()
  })
})

describe("ErpNext.listRecentBridgeDepositRows", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("reads Bridge Topup rows for the customer since the cutoff, newest first", async () => {
    const rows = [{ request_id: "dep-1", status: "Completed" }]
    mockedAxios.get.mockResolvedValue({ data: { data: rows } })

    const result = await client.listRecentBridgeDepositRows({
      bridgeCustomerId: "cust-1",
      since: new Date("2026-11-10T15:00:00Z"),
    })

    expect(result).toEqual(rows)
    const [url, { params }] = mockedAxios.get.mock.calls[0]
    expect(url).toBe("https://erp.example/api/resource/Bridge%20Transfer%20Request")
    expect(JSON.parse(params.filters)).toEqual([
      ["Bridge Transfer Request", "provider", "=", "Bridge"],
      ["Bridge Transfer Request", "transaction_type", "=", "Topup"],
      ["Bridge Transfer Request", "bridge_customer_id", "=", "cust-1"],
      ["Bridge Transfer Request", "request_id", "not like", "ibex:%"],
      ["Bridge Transfer Request", "last_seen_at", ">=", "2026-11-10 15:00:00"],
    ])
    expect(JSON.parse(params.fields)).toEqual(
      expect.arrayContaining(["raw_payload_json", "last_seen_at", "status", "amount"]),
    )
    expect(params.order_by).toBe("last_seen_at desc")
  })

  it("returns an error, not an empty list, when ERPNext fails", async () => {
    mockedAxios.get.mockRejectedValue(new Error("ECONNRESET"))

    const result = await client.listRecentBridgeDepositRows({
      bridgeCustomerId: "cust-1",
      since: new Date(),
    })

    expect(result).toBeInstanceOf(BridgeDepositHistoryQueryError)
  })

  it("returns an error on a malformed response", async () => {
    mockedAxios.get.mockResolvedValue({ data: {} })

    const result = await client.listRecentBridgeDepositRows({
      bridgeCustomerId: "cust-1",
      since: new Date(),
    })

    expect(result).toBeInstanceOf(BridgeDepositHistoryQueryError)
  })
})
