const mockFindUserById = jest.fn()
const mockUpdateUser = jest.fn()
const mockFindAccountById = jest.fn()
const mockFindAccountByUserId = jest.fn()
const mockUpdateAccount = jest.fn()
const mockGetIdentity = jest.fn()
const mockGetUpgradeRequestList = jest.fn()
const mockCloseUpgradeRequests = jest.fn()
const mockPostUpgradeRequest = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@services/mongoose", () => ({
  UsersRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindUserById(...args),
    update: (...args: unknown[]) => mockUpdateUser(...args),
  })),
  AccountsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindAccountById(...args),
    findByUserId: (...args: unknown[]) => mockFindAccountByUserId(...args),
    update: (...args: unknown[]) => mockUpdateAccount(...args),
  })),
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: jest.fn(() => ({
    getIdentity: (...args: unknown[]) => mockGetIdentity(...args),
  })),
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getAccountUpgradeRequestList: (...args: unknown[]) =>
      mockGetUpgradeRequestList(...args),
    closeAccountUpgradeRequests: (...args: unknown[]) =>
      mockCloseUpgradeRequests(...args),
    postUpgradeRequest: (...args: unknown[]) => mockPostUpgradeRequest(...args),
  },
}))

jest.mock("@services/frappe/models/AccountUpgradeRequest", () => {
  const actual = jest.requireActual("@services/frappe/models/AccountUpgradeRequest")
  return {
    ...actual,
    AccountUpgradeRequest: jest.fn().mockImplementation(() => ({
      validate: jest.fn(async () => ({ name: "" })),
    })),
  }
})

import { AccountLevel } from "@domain/accounts"
import { upgradeAccountFromDeviceToPhone } from "@app/accounts/upgrade-device-account"
import { updateAccountLevel } from "@app/accounts/update-account-level"
import { createUpgradeRequest } from "@app/accounts/business-account-upgrade-request"
import { notifyOpsEvent } from "@services/alerts/ops-events"

class RepoBoomError extends Error {}

const userId = "11111111-1111-4111-8111-111111111111" as UserId
const accountId = "64df1a2b3c4d5e6f78901234" as AccountId
const phone = "+18765550100" as PhoneNumber

describe("ops events — accounts hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("upgradeAccountFromDeviceToPhone", () => {
    it("notifies promoted on success", async () => {
      mockFindUserById.mockResolvedValue({ id: userId })
      mockUpdateUser.mockResolvedValue({ id: userId, phone })
      mockFindAccountByUserId.mockResolvedValue({
        id: accountId,
        level: AccountLevel.Zero,
      })
      mockUpdateAccount.mockImplementation(async (account) => account)

      const result = await upgradeAccountFromDeviceToPhone({ userId, phone })

      expect(result).not.toBeInstanceOf(Error)
      expect((result as Account).level).toBe(AccountLevel.One)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "promoted",
          status: "success",
          accountId,
          userId,
          phone,
          meta: { from: "trial", to: "verified" },
        }),
      )
    })

    it("does not notify when the account update fails", async () => {
      mockFindUserById.mockResolvedValue({ id: userId })
      mockUpdateUser.mockResolvedValue({ id: userId, phone })
      mockFindAccountByUserId.mockResolvedValue({
        id: accountId,
        level: AccountLevel.Zero,
      })
      mockUpdateAccount.mockResolvedValue(new RepoBoomError("db down"))

      const result = await upgradeAccountFromDeviceToPhone({ userId, phone })

      expect(result).toBeInstanceOf(RepoBoomError)
      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })
  })

  describe("updateAccountLevel", () => {
    it("notifies approved with old and new level on success", async () => {
      mockFindAccountById.mockResolvedValue({ id: accountId, level: AccountLevel.One })
      mockUpdateAccount.mockImplementation(async (account) => account)

      const result = await updateAccountLevel({
        id: accountId,
        level: AccountLevel.Two,
        erpParty: "CUST-0001",
      })

      expect(result).not.toBeInstanceOf(Error)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "upgrade",
          phase: "approved",
          status: "success",
          accountId,
          meta: { from: String(AccountLevel.One), to: String(AccountLevel.Two) },
        }),
      )
    })

    it("does not notify when the update fails", async () => {
      mockFindAccountById.mockResolvedValue({ id: accountId, level: AccountLevel.One })
      mockUpdateAccount.mockResolvedValue(new RepoBoomError("db down"))

      const result = await updateAccountLevel({
        id: accountId,
        level: AccountLevel.Two,
        erpParty: "CUST-0001",
      })

      expect(result).toBeInstanceOf(RepoBoomError)
      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })

    it("does not notify on validation errors", async () => {
      const result = await updateAccountLevel({ id: accountId, level: AccountLevel.Two })

      expect(result).toBeInstanceOf(Error)
      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })
  })

  describe("createUpgradeRequest", () => {
    const input = {
      level: AccountLevel.Pro,
      accountId,
      fullName: "Test Business",
      address: {
        title: "HQ",
        line1: "1 Main St",
        city: "Kingston",
        state: "St. Andrew",
        country: "Jamaica",
      },
      terminalsRequested: 1,
      idDocument: "doc-1",
    }

    beforeEach(() => {
      mockFindAccountById.mockResolvedValue({
        id: accountId,
        kratosUserId: userId,
        username: "testbiz",
        level: AccountLevel.One,
      })
      mockFindUserById.mockResolvedValue({ id: userId, phone })
      mockGetIdentity.mockResolvedValue({ email: "biz@example.com" })
      mockGetUpgradeRequestList.mockResolvedValue([])
      mockCloseUpgradeRequests.mockResolvedValue(true)
    })

    it("notifies requested after the ERPNext post succeeds", async () => {
      mockPostUpgradeRequest.mockResolvedValue({ name: "UPG-0001" })

      const result = await createUpgradeRequest(accountId, input)

      expect(result).not.toBeInstanceOf(Error)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "upgrade",
          phase: "requested",
          status: "pending",
          accountId,
          meta: expect.objectContaining({
            requestId: "UPG-0001",
            from: String(AccountLevel.One),
            to: String(AccountLevel.Pro),
          }),
        }),
      )
    })

    it("does not notify when the ERPNext post fails", async () => {
      mockPostUpgradeRequest.mockResolvedValue(new RepoBoomError("erpnext down"))

      const result = await createUpgradeRequest(accountId, input)

      expect(result).toBeInstanceOf(RepoBoomError)
      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })
  })
})
