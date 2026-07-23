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
import { BankAccountUpdateRequest } from "@services/frappe/models/BankAccountUpdateRequest"
import { RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"
import { BankAccountUpdateRequestQueryError } from "@services/frappe/errors"

const mockedAxios = axios as unknown as {
  get: jest.Mock
  post: jest.Mock
  put: jest.Mock
}

const client = new ErpNext("https://erp.example", "erp.example", {
  apiKey: "key",
  apiSecret: "secret",
})

const makeRequest = () =>
  new BankAccountUpdateRequest("", "CUST-1", "BANK-ACC-1", RequestStatus.Pending, {
    bank: "NCB",
    branch_code: "Half Way Tree",
    account_type: "Savings",
    currency: "JMD",
    bank_account_no: "123456",
  })

describe("ErpNext bank account update requests", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("posts a create to the Bank Account Update Request resource", async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: { name: "BAUR-1" } } })

    const result = await client.postBankAccountUpdateRequest(makeRequest())

    expect(result).toEqual({ name: "BAUR-1" })
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bank%20Account%20Update%20Request",
      expect.objectContaining({
        bank_account: "BANK-ACC-1",
        bank_name: "NCB",
        account_number: "123456",
        status: "Pending",
      }),
      expect.any(Object),
    )
  })

  it("hydrates open requests for an account", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BAUR-1",
            party: "CUST-1",
            bank_account: "BANK-ACC-1",
            status: "Pending",
            bank_name: "NCB",
            bank_branch: "Half Way Tree",
            account_type: "Savings",
            currency: "JMD",
            account_number: "123456",
          },
        ],
      },
    })

    const result = await client.getOpenBankAccountUpdateRequestsForAccount("BANK-ACC-1")

    expect(Array.isArray(result)).toBe(true)
    const list = result as BankAccountUpdateRequest[]
    expect(list).toHaveLength(1)
    expect(list[0].bankAccountId).toBe("BANK-ACC-1")
    expect(list[0].newBankAccount.bank).toBe("NCB")
  })

  it("returns a query error when the lookup fails", async () => {
    mockedAxios.get.mockRejectedValue({ isAxiosError: true, response: { data: {} } })

    const result = await client.getOpenBankAccountUpdateRequestsForAccount("BANK-ACC-1")

    expect(result).toBeInstanceOf(BankAccountUpdateRequestQueryError)
  })

  it("bulk-closes prior requests", async () => {
    mockedAxios.post.mockResolvedValue({ data: { message: { failed_docs: [] } } })

    const result = await client.closeBankAccountUpdateRequests(["BAUR-1", "BAUR-2"])

    expect(result).toBeUndefined()
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://erp.example/api/method/frappe.client.bulk_update",
      expect.objectContaining({ docs: expect.stringContaining("BAUR-1") }),
      expect.any(Object),
    )
  })

  it("no-ops close when there are no names", async () => {
    const result = await client.closeBankAccountUpdateRequests([])

    expect(result).toBeUndefined()
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it("fetches the most recent request for an account, any status", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BAUR-9",
            party: "CUST-1",
            bank_account: "BANK-ACC-1",
            status: "Rejected",
            bank_name: "NCB",
            bank_branch: "Half Way Tree",
            account_type: "Savings",
            currency: "JMD",
            account_number: "123456",
            support_note: "account number did not match",
          },
        ],
      },
    })

    const result = await client.getLatestBankAccountUpdateRequestForAccount("BANK-ACC-1")

    expect((result as BankAccountUpdateRequest).status).toBe("Rejected")
    expect((result as BankAccountUpdateRequest).supportNote).toBe(
      "account number did not match",
    )
  })

  it("returns undefined when the account has no requests", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    const result = await client.getLatestBankAccountUpdateRequestForAccount("BANK-ACC-1")

    expect(result).toBeUndefined()
  })
})
