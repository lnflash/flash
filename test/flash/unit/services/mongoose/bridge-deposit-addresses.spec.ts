/* eslint-disable @typescript-eslint/no-explicit-any */

const mockFindOne = jest.fn()
const mockUpdateMany = jest.fn()
const mockCreate = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  BridgeDepositAddress: {
    findOne: (...args: any[]) => mockFindOne(...args),
    updateMany: (...args: any[]) => mockUpdateMany(...args),
    create: (...args: any[]) => mockCreate(...args),
  },
}))

import {
  deactivateDepositAddress,
  findActiveDepositAddress,
  upsertDepositAddress,
} from "@services/mongoose/bridge-deposit-addresses"

describe("BridgeDepositAddress repository", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns null when there is no active deposit address", async () => {
    mockFindOne.mockResolvedValue(null)

    const result = await findActiveDepositAddress("acct-1")

    expect(result).toBeNull()
    expect(mockFindOne).toHaveBeenCalledWith({ accountId: "acct-1", isActive: true })
  })

  it("maps an active deposit address record", async () => {
    mockFindOne.mockResolvedValue({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xabc",
      ibexReceiveInfoId: "receive-1",
    })

    const result = await findActiveDepositAddress("acct-1")

    expect(result).toEqual({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xabc",
      ibexReceiveInfoId: "receive-1",
    })
  })

  it("returns the existing active address when upserting the same address", async () => {
    mockFindOne.mockResolvedValue({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xabc",
      ibexReceiveInfoId: "receive-1",
    })

    const result = await upsertDepositAddress({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xabc",
      ibexReceiveInfoId: "receive-1",
    })

    expect(result).toEqual({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xabc",
      ibexReceiveInfoId: "receive-1",
    })
    expect(mockUpdateMany).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("deactivates any prior active address and inserts a new one", async () => {
    mockFindOne.mockResolvedValue(null)
    mockCreate.mockResolvedValue({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xdef",
      ibexReceiveInfoId: "receive-2",
    })

    const result = await upsertDepositAddress({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xdef",
      ibexReceiveInfoId: "receive-2",
    })

    expect(mockUpdateMany).toHaveBeenCalledWith(
      { accountId: "acct-1", isActive: true },
      { isActive: false },
    )
    expect(mockCreate).toHaveBeenCalledWith({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xdef",
      ibexReceiveInfoId: "receive-2",
      isActive: true,
    })
    expect(result).toEqual({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xdef",
      ibexReceiveInfoId: "receive-2",
    })
  })

  it("deactivates active addresses", async () => {
    mockUpdateMany.mockResolvedValue({ acknowledged: true })

    await deactivateDepositAddress("acct-1")

    expect(mockUpdateMany).toHaveBeenCalledWith(
      { accountId: "acct-1", isActive: true },
      { isActive: false },
    )
  })
})
