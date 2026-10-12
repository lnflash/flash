const mockListByWalletId = jest.fn()

jest.mock("@services/mongoose/payment-split-rules", () => ({
  PaymentSplitRulesRepository: jest.fn(() => ({
    listByWalletId: (...args: unknown[]) => mockListByWalletId(...args),
  })),
}))

import { resolveWalletSplits } from "@graphql/shared/types/object/wallet-split"

const wallet = { id: "wallet-1", accountId: "owner" } as unknown as Wallet
const rule = {
  id: "rule-1",
  walletId: "wallet-1",
  destinationWalletId: "dest",
  percent: 10,
  enabled: true,
  createdAt: new Date(),
}

beforeEach(() => {
  jest.clearAllMocks()
  mockListByWalletId.mockResolvedValue([rule])
})

describe("Wallet.splits resolver", () => {
  it("returns the wallet's split rules to its owner", async () => {
    expect(
      await resolveWalletSplits(wallet, {}, { domainAccount: { id: "owner" } }),
    ).toEqual([rule])
    expect(mockListByWalletId).toHaveBeenCalledWith("wallet-1")
  })

  it("returns an empty list to any other account", async () => {
    expect(
      await resolveWalletSplits(wallet, {}, { domainAccount: { id: "intruder" } }),
    ).toEqual([])
    expect(mockListByWalletId).not.toHaveBeenCalled()
  })

  it("surfaces a repository failure as a GraphQL error", async () => {
    mockListByWalletId.mockResolvedValue(new Error("mongo down"))

    await expect(
      resolveWalletSplits(wallet, {}, { domainAccount: { id: "owner" } }),
    ).rejects.toBeDefined()
  })
})
