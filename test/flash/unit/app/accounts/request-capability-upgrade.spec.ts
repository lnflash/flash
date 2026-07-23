jest.mock("@services/mongoose", () => {
  const findById = jest.fn()
  return { AccountsRepository: () => ({ findById }) }
})

jest.mock("@app/accounts/get-account-capabilities", () => ({
  getAccountCapabilities: jest.fn(),
}))

jest.mock("@app/accounts/business-account-upgrade-request", () => ({
  createUpgradeRequest: jest.fn(),
}))

import { AccountsRepository } from "@services/mongoose"
import { getAccountCapabilities } from "@app/accounts/get-account-capabilities"
import { createUpgradeRequest } from "@app/accounts/business-account-upgrade-request"
import { requestCapabilityUpgrade } from "@app/accounts/request-capability-upgrade"
import { AccountLevel, RequestableCapability } from "@domain/accounts"
import { ValidationError } from "@domain/shared"

import type { BankAccount } from "@services/frappe/models/BankAccount"

const { findById } = AccountsRepository() as unknown as { findById: jest.Mock }
const getCaps = getAccountCapabilities as unknown as jest.Mock
const createReq = createUpgradeRequest as unknown as jest.Mock

const ACCOUNT_ID = "acct-1" as AccountId
const account = { id: ACCOUNT_ID, level: AccountLevel.One } as unknown as Account

const bankAccount = {
  bank: "NCB",
  branch_code: "Half Way Tree",
  account_type: "Savings",
  currency: "JMD",
  bank_account_no: "123456789",
} as unknown as BankAccount

const baseInput = {
  fullName: "Test User",
  address: {
    title: "Home",
    line1: "1 Main St",
    city: "Kingston",
    state: "St Andrew",
    country: "Jamaica",
  },
  terminalsRequested: 0,
}

const caps = (overrides: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
  verified: true,
  bankPayout: false,
  business: false,
  usdAccount: false,
  ...overrides,
})

describe("requestCapabilityUpgrade", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    findById.mockResolvedValue(account)
    getCaps.mockResolvedValue({ capabilities: caps() })
    createReq.mockResolvedValue({ id: "REQ-1", status: "Pending" })
  })

  it("rejects an unverified account before creating any request", async () => {
    getCaps.mockResolvedValue({ capabilities: caps({ verified: false }) })

    const result = await requestCapabilityUpgrade(ACCOUNT_ID, {
      ...baseInput,
      capability: RequestableCapability.BankPayout,
      bankAccount,
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(createReq).not.toHaveBeenCalled()
  })

  it("rejects a capability the account already has", async () => {
    getCaps.mockResolvedValue({ capabilities: caps({ bankPayout: true }) })

    const result = await requestCapabilityUpgrade(ACCOUNT_ID, {
      ...baseInput,
      capability: RequestableCapability.BankPayout,
      bankAccount,
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(createReq).not.toHaveBeenCalled()
  })

  it("requires bank account details for a bank-payout request", async () => {
    const result = await requestCapabilityUpgrade(ACCOUNT_ID, {
      ...baseInput,
      capability: RequestableCapability.BankPayout,
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(createReq).not.toHaveBeenCalled()
  })

  it("creates an L2 request for a verified account adding bank payout", async () => {
    await requestCapabilityUpgrade(ACCOUNT_ID, {
      ...baseInput,
      capability: RequestableCapability.BankPayout,
      bankAccount,
    })

    expect(createReq).toHaveBeenCalledTimes(1)
    expect(createReq).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ level: AccountLevel.Two, bankAccount }),
    )
  })

  it("creates an L3 business request reusing a bank account already on file", async () => {
    getCaps.mockResolvedValue({ capabilities: caps({ bankPayout: true }) })

    await requestCapabilityUpgrade(ACCOUNT_ID, {
      ...baseInput,
      capability: RequestableCapability.Business,
    })

    expect(createReq).toHaveBeenCalledTimes(1)
    expect(createReq).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ level: AccountLevel.Business, bankAccount: undefined }),
    )
  })
})
