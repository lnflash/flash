jest.mock("@services/mongoose", () => {
  const findById = jest.fn()
  return { AccountsRepository: () => ({ findById }) }
})

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getBankAccountsByCustomer: jest.fn(),
    getOpenBankAccountUpdateRequestsForAccount: jest.fn(),
    closeBankAccountUpdateRequests: jest.fn(),
    postBankAccountUpdateRequest: jest.fn(),
  },
}))

import { AccountsRepository } from "@services/mongoose"
import ErpNext from "@services/frappe/ErpNext"
import { createBankAccountUpdateRequest } from "@app/accounts/bank-account-update-request"
import { ValidationError } from "@domain/shared"
import { RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"
import { BankAccountQueryError } from "@services/frappe/errors"

const { findById } = AccountsRepository() as unknown as { findById: jest.Mock }
const erp = ErpNext as unknown as {
  getBankAccountsByCustomer: jest.Mock
  getOpenBankAccountUpdateRequestsForAccount: jest.Mock
  closeBankAccountUpdateRequests: jest.Mock
  postBankAccountUpdateRequest: jest.Mock
}

const ACCOUNT_ID = "acct-1" as AccountId

const ownedAccount = { id: ACCOUNT_ID, erpParty: "CUST-1" } as unknown as Account

const currentBank = {
  name: "BANK-ACC-1",
  bank: "NCB",
  branch_code: "Old Branch",
  account_type: "Savings",
  currency: "JMD",
  bank_account_no: "111111",
}

const newValues = {
  bank: "Scotiabank",
  branch_code: "New Branch",
  account_type: "Chequing",
  currency: "JMD",
  bank_account_no: "222222",
}

describe("createBankAccountUpdateRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("rejects when the account has no erpParty", async () => {
    findById.mockResolvedValue({ id: ACCOUNT_ID } as unknown as Account)

    const result = await createBankAccountUpdateRequest(ACCOUNT_ID, {
      bankAccountId: "BANK-ACC-1",
      bankAccount: newValues,
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(erp.getBankAccountsByCustomer).not.toHaveBeenCalled()
  })

  it("rejects when the target account is not owned by the user", async () => {
    findById.mockResolvedValue(ownedAccount)
    erp.getBankAccountsByCustomer.mockResolvedValue([currentBank])

    const result = await createBankAccountUpdateRequest(ACCOUNT_ID, {
      bankAccountId: "SOMEONE-ELSES-ACC",
      bankAccount: newValues,
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(erp.postBankAccountUpdateRequest).not.toHaveBeenCalled()
  })

  it("rejects a currency change", async () => {
    findById.mockResolvedValue(ownedAccount)
    erp.getBankAccountsByCustomer.mockResolvedValue([currentBank])

    const result = await createBankAccountUpdateRequest(ACCOUNT_ID, {
      bankAccountId: "BANK-ACC-1",
      bankAccount: { ...newValues, currency: "USD" },
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(erp.postBankAccountUpdateRequest).not.toHaveBeenCalled()
  })

  it("propagates a bank-account lookup error", async () => {
    findById.mockResolvedValue(ownedAccount)
    const err = new BankAccountQueryError("boom")
    erp.getBankAccountsByCustomer.mockResolvedValue(err)

    const result = await createBankAccountUpdateRequest(ACCOUNT_ID, {
      bankAccountId: "BANK-ACC-1",
      bankAccount: newValues,
    })

    expect(result).toBe(err)
    expect(erp.postBankAccountUpdateRequest).not.toHaveBeenCalled()
  })

  it("supersedes prior pending requests and creates a new one", async () => {
    findById.mockResolvedValue(ownedAccount)
    erp.getBankAccountsByCustomer.mockResolvedValue([currentBank])
    erp.getOpenBankAccountUpdateRequestsForAccount.mockResolvedValue([
      { name: "REQ-OLD" },
    ])
    erp.closeBankAccountUpdateRequests.mockResolvedValue(undefined)
    erp.postBankAccountUpdateRequest.mockResolvedValue({ name: "REQ-NEW" })

    const result = await createBankAccountUpdateRequest(ACCOUNT_ID, {
      bankAccountId: "BANK-ACC-1",
      bankAccount: newValues,
    })

    expect(erp.closeBankAccountUpdateRequests).toHaveBeenCalledWith(["REQ-OLD"])
    expect(erp.postBankAccountUpdateRequest).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ id: "REQ-NEW", status: RequestStatus.Pending })
  })

  it("does not close prior requests when the create fails", async () => {
    findById.mockResolvedValue(ownedAccount)
    erp.getBankAccountsByCustomer.mockResolvedValue([currentBank])
    erp.getOpenBankAccountUpdateRequestsForAccount.mockResolvedValue([
      { name: "REQ-OLD" },
    ])
    const createErr = new Error("erpnext down")
    erp.postBankAccountUpdateRequest.mockResolvedValue(createErr)

    const result = await createBankAccountUpdateRequest(ACCOUNT_ID, {
      bankAccountId: "BANK-ACC-1",
      bankAccount: newValues,
    })

    expect(result).toBe(createErr)
    expect(erp.closeBankAccountUpdateRequests).not.toHaveBeenCalled()
  })

  it("rejects an empty account number before creating anything", async () => {
    findById.mockResolvedValue(ownedAccount)
    erp.getBankAccountsByCustomer.mockResolvedValue([currentBank])

    const result = await createBankAccountUpdateRequest(ACCOUNT_ID, {
      bankAccountId: "BANK-ACC-1",
      bankAccount: { ...newValues, bank_account_no: "" },
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(erp.postBankAccountUpdateRequest).not.toHaveBeenCalled()
  })

  it("rejects an account type outside the allowed set", async () => {
    findById.mockResolvedValue(ownedAccount)
    erp.getBankAccountsByCustomer.mockResolvedValue([currentBank])

    const result = await createBankAccountUpdateRequest(ACCOUNT_ID, {
      bankAccountId: "BANK-ACC-1",
      bankAccount: { ...newValues, account_type: "Current" },
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(erp.postBankAccountUpdateRequest).not.toHaveBeenCalled()
  })
})
