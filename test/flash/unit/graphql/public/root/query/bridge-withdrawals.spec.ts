jest.mock("@services/bridge", () => ({
  __esModule: true,
  default: {
    getWithdrawals: jest.fn(),
  },
}))

jest.mock("@config", () => ({
  BridgeConfig: { enabled: true },
  getOnChainWalletConfig: jest.fn().mockReturnValue({ dustThreshold: 546 }),
}))

jest.mock("@services/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { baseLogger: logger }
})

import BridgeService from "@services/bridge"
import bridgeWithdrawals from "@graphql/public/root/query/bridge-withdrawals"

const ACCOUNT_ID = "account-001" as AccountId
const WITHDRAWAL_ID = "withdrawal-001"
const TRANSFER_ID = "transfer-001"
const CREATED_AT = "2026-01-01T00:00:00.000Z"

const ctx = {
  domainAccount: { id: ACCOUNT_ID, level: 2 },
} as unknown as GraphQLPublicContextAuth

describe("bridgeWithdrawals resolver", () => {
  beforeEach(() => jest.clearAllMocks())

  it("returns service rows with id/status for the BridgeWithdrawal GraphQL type", async () => {
    const serviceRow = {
      id: WITHDRAWAL_ID,
      amount: "50",
      currency: "usdt",
      externalAccountId: "ext-001",
      status: "submitted",
      bridgeTransferId: TRANSFER_ID,
      failureReason: undefined,
      createdAt: CREATED_AT,
    }
    ;(BridgeService.getWithdrawals as jest.Mock).mockResolvedValue([serviceRow])

    const result = await bridgeWithdrawals.resolve?.(null, {}, ctx, {} as never)

    expect(BridgeService.getWithdrawals).toHaveBeenCalledWith(ACCOUNT_ID)
    expect(result).toEqual([serviceRow])
    expect(result?.[0].id).toBe(WITHDRAWAL_ID)
    expect(result?.[0].status).toBe("submitted")
    expect((result?.[0] as Record<string, unknown>).transferId).toBeUndefined()
    expect((result?.[0] as Record<string, unknown>).state).toBeUndefined()
  })
})
