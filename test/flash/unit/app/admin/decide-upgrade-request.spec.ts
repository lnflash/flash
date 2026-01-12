/* eslint-disable @typescript-eslint/no-explicit-any */

import { UpgradeRequestQueryError, UpgradeRequestUpdateError } from "@services/frappe/errors"

const mockUpdateUpgradeRequestStatus = jest.fn()
const mockGetAccountUpgradeRequestByName = jest.fn()
const mockFindByUsername = jest.fn()
const mockUpdateAccountLevel = jest.fn()

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    updateUpgradeRequestStatus: (...args: any[]) => mockUpdateUpgradeRequestStatus(...args),
    getAccountUpgradeRequestByName: (...args: any[]) =>
      mockGetAccountUpgradeRequestByName(...args),
  },
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findByUsername: (...args: any[]) => mockFindByUsername(...args),
  }),
}))

jest.mock("@app/accounts/update-account-level", () => ({
  updateAccountLevel: (...args: any[]) => mockUpdateAccountLevel(...args),
}))

import { decideUpgradeRequest } from "@app/admin/decide-upgrade-request"

const mockRequest = {
  name: "ACC-UPG-00001",
  username: "testuser",
  currentLevel: 1,
  requestedLevel: 2,
}

const mockAccount = {
  id: "account-123" as AccountId,
  username: "testuser",
}

describe("decideUpgradeRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("approval flow", () => {
    it("approves request and updates account level", async () => {
      mockUpdateUpgradeRequestStatus.mockResolvedValue(undefined)
      mockGetAccountUpgradeRequestByName.mockResolvedValue(mockRequest)
      mockFindByUsername.mockResolvedValue(mockAccount)
      mockUpdateAccountLevel.mockResolvedValue(mockAccount)

      const result = await decideUpgradeRequest({
        requestName: "ACC-UPG-00001",
        approve: true,
      })

      expect(result).toBe(true)
      expect(mockUpdateUpgradeRequestStatus).toHaveBeenCalledWith("ACC-UPG-00001", "Approved")
      expect(mockGetAccountUpgradeRequestByName).toHaveBeenCalledWith("ACC-UPG-00001")
      expect(mockFindByUsername).toHaveBeenCalledWith("testuser")
      expect(mockUpdateAccountLevel).toHaveBeenCalledWith({
        id: "account-123",
        level: 2,
      })
    })
  })

  describe("rejection flow", () => {
    it("rejects request without updating account level", async () => {
      mockUpdateUpgradeRequestStatus.mockResolvedValue(undefined)

      const result = await decideUpgradeRequest({
        requestName: "ACC-UPG-00001",
        approve: false,
      })

      expect(result).toBe(true)
      expect(mockUpdateUpgradeRequestStatus).toHaveBeenCalledWith("ACC-UPG-00001", "Rejected")
      expect(mockGetAccountUpgradeRequestByName).not.toHaveBeenCalled()
      expect(mockUpdateAccountLevel).not.toHaveBeenCalled()
    })
  })

  describe("error handling", () => {
    it("returns error when ERPNext update fails", async () => {
      mockUpdateUpgradeRequestStatus.mockResolvedValue(
        new UpgradeRequestUpdateError("Connection failed"),
      )

      const result = await decideUpgradeRequest({
        requestName: "ACC-UPG-00001",
        approve: true,
      })

      expect(result).toBeInstanceOf(UpgradeRequestUpdateError)
    })

    it("returns error when request not found", async () => {
      mockUpdateUpgradeRequestStatus.mockResolvedValue(undefined)
      mockGetAccountUpgradeRequestByName.mockResolvedValue(
        new UpgradeRequestQueryError("Not found"),
      )

      const result = await decideUpgradeRequest({
        requestName: "ACC-UPG-00001",
        approve: true,
      })

      expect(result).toBeInstanceOf(UpgradeRequestQueryError)
    })
  })
})
