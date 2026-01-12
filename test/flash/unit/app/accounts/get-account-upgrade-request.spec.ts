/* eslint-disable @typescript-eslint/no-explicit-any */

import { UpgradeRequestQueryError } from "@services/frappe/errors"

const mockGetAccountUpgradeRequest = jest.fn()

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getAccountUpgradeRequest: (...args: any[]) => mockGetAccountUpgradeRequest(...args),
  },
}))

import { getAccountUpgradeRequest } from "@app/accounts/get-account-upgrade-request"

const mockUpgradeRequest = {
  name: "ACC-UPG-00001",
  username: "testuser",
  currentLevel: 1,
  requestedLevel: 2,
  status: "Pending",
  fullName: "Test User",
  phoneNumber: "+18761234567",
  email: "test@example.com",
  businessName: "Test Business",
  businessAddress: "123 Main St",
}

describe("getAccountUpgradeRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns upgrade request when found", async () => {
    mockGetAccountUpgradeRequest.mockResolvedValue(mockUpgradeRequest)

    const result = await getAccountUpgradeRequest("testuser")

    expect(result).toEqual(mockUpgradeRequest)
    expect(mockGetAccountUpgradeRequest).toHaveBeenCalledWith("testuser")
  })

  it("returns error when no upgrade request exists", async () => {
    mockGetAccountUpgradeRequest.mockResolvedValue(
      new UpgradeRequestQueryError("No data in detail response"),
    )

    const result = await getAccountUpgradeRequest("nonexistent-user")

    expect(result).toBeInstanceOf(UpgradeRequestQueryError)
  })

  it("returns error when ERPNext query fails", async () => {
    mockGetAccountUpgradeRequest.mockResolvedValue(
      new UpgradeRequestQueryError("Connection failed"),
    )

    const result = await getAccountUpgradeRequest("testuser")

    expect(result).toBeInstanceOf(UpgradeRequestQueryError)
  })

  it("passes username to ErpNext service", async () => {
    mockGetAccountUpgradeRequest.mockResolvedValue(mockUpgradeRequest)

    await getAccountUpgradeRequest("myusername")

    expect(mockGetAccountUpgradeRequest).toHaveBeenCalledWith("myusername")
  })
})
