jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: { getBankAccountsByCustomer: jest.fn() },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { warn: jest.fn() },
}))

import ErpNext from "@services/frappe/ErpNext"

import { getAccountCapabilities } from "@app/accounts/get-account-capabilities"
import { AccountLevel } from "@domain/accounts"

const getBankAccounts = ErpNext?.getBankAccountsByCustomer as jest.Mock

const account = (overrides: Partial<Account> = {}): Account =>
  ({
    id: "acct-1" as AccountId,
    level: AccountLevel.One,
    erpParty: "CUST-1",
    ...overrides,
  }) as unknown as Account

describe("getAccountCapabilities", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getBankAccounts.mockResolvedValue([])
  })

  it("flags bankPayout from an ERPNext bank account on file", async () => {
    getBankAccounts.mockResolvedValue([{ name: "BANK-ACC-1" }])

    const { capabilities } = await getAccountCapabilities(account())

    expect(getBankAccounts).toHaveBeenCalledWith("CUST-1")
    expect(capabilities.bankPayout).toBe(true)
  })

  it("falls back to the stored level when the ERPNext lookup fails", async () => {
    getBankAccounts.mockResolvedValue(new Error("ERPNext unreachable"))

    const l2 = await getAccountCapabilities(account({ level: AccountLevel.Two }))
    expect(l2.capabilities.bankPayout).toBe(true)

    const l1 = await getAccountCapabilities(account({ level: AccountLevel.One }))
    expect(l1.capabilities.bankPayout).toBe(false)
  })

  it("skips the ERPNext lookup for accounts without an ERP party", async () => {
    const { capabilities } = await getAccountCapabilities(
      account({ erpParty: undefined, level: AccountLevel.Two }),
    )

    expect(getBankAccounts).not.toHaveBeenCalled()
    // Grandfathered from the stored level.
    expect(capabilities.bankPayout).toBe(true)
  })

  it("flags usdAccount from approved Bridge KYC", async () => {
    const { capabilities } = await getAccountCapabilities(
      account({ bridgeKycStatus: "approved" }),
    )
    expect(capabilities.usdAccount).toBe(true)
  })

  it("derives the headline from the same capabilities", async () => {
    const { capabilities, statusHeadline } = await getAccountCapabilities(account())
    expect(capabilities.verified).toBe(true)
    expect(statusHeadline).toBe("VERIFIED")
  })

  it("memoizes per account object — one ERPNext lookup for many field resolutions", async () => {
    const source = account()

    const [a, b] = await Promise.all([
      getAccountCapabilities(source),
      getAccountCapabilities(source),
    ])
    const c = await getAccountCapabilities(source)

    expect(getBankAccounts).toHaveBeenCalledTimes(1)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it("does not share the memo across distinct account objects", async () => {
    await getAccountCapabilities(account())
    await getAccountCapabilities(account())

    expect(getBankAccounts).toHaveBeenCalledTimes(2)
  })
})
