/* eslint-disable @typescript-eslint/no-explicit-any */

const mockFindAccountById = jest.fn()
const mockFindActiveDepositAddress = jest.fn()
const mockUpsertDepositAddress = jest.fn()
const mockListByAccountId = jest.fn()
const mockCreateEthUsdtReceiveAddress = jest.fn()
const mockCreateVirtualAccount = jest.fn()
const mockFindExternalAccountsByAccountId = jest.fn()
const mockCreateTransfer = jest.fn()

jest.mock("@config", () => ({
  BridgeConfig: {
    enabled: true,
    webhook: {
      port: 4009,
      timestampSkewMs: 300000,
      publicKeys: { kyc: "k", deposit: "d", transfer: "t" },
    },
  },
}))

jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: ({ fns }: any) => fns,
}))

jest.mock("@services/logger", () => ({
  baseLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: () => ({
    findById: (...args: any[]) => mockFindAccountById(...args),
  }),
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({
  createVirtualAccount: (...args: any[]) => mockCreateVirtualAccount(...args),
  findExternalAccountsByAccountId: (...args: any[]) => mockFindExternalAccountsByAccountId(...args),
  createWithdrawal: jest.fn(),
  findWithdrawalsByAccountId: jest.fn(),
  updateExternalAccountStatus: jest.fn(),
  updateWithdrawalStatus: jest.fn(),
  findWithdrawalByBridgeTransferId: jest.fn(),
}))

jest.mock("@services/mongoose/bridge-deposit-addresses", () => ({
  findActiveDepositAddress: (...args: any[]) => mockFindActiveDepositAddress(...args),
  upsertDepositAddress: (...args: any[]) => mockUpsertDepositAddress(...args),
}))

jest.mock("@services/mongoose/wallets", () => ({
  WalletsRepository: () => ({
    listByAccountId: (...args: any[]) => mockListByAccountId(...args),
  }),
}))

jest.mock("@services/ibex", () => ({
  __esModule: true,
  default: {
    client: {
      createEthUsdtReceiveAddress: (...args: any[]) => mockCreateEthUsdtReceiveAddress(...args),
    },
  },
}))

jest.mock("../../../../../src/services/bridge/client", () => ({
  __esModule: true,
  default: {
    createVirtualAccount: (...args: any[]) => mockCreateVirtualAccount(...args),
    createTransfer: (...args: any[]) => mockCreateTransfer(...args),
  },
}))

import BridgeService from "@services/bridge"

describe("bridge service", () => {
  const account = {
    id: "acct-1",
    level: 2,
    username: "alice",
    kratosUserId: "kratos-1",
    bridgeCustomerId: "cust-1",
    bridgeKycStatus: "approved",
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockFindAccountById.mockResolvedValue(account)
    mockCreateVirtualAccount.mockResolvedValue({
      id: "va-1",
      source_deposit_instructions: {
        bank_name: "Bridge Bank",
        bank_routing_number: "021000021",
        bank_account_number: "123456789",
      },
    })
    mockCreateTransfer.mockResolvedValue({
      id: "tr-1",
      amount: "25",
      currency: "usdt",
      state: "pending",
    })
    mockFindExternalAccountsByAccountId.mockResolvedValue([
      { bridgeExternalAccountId: "ext-1", status: "verified" },
    ])
  })

  it("reuses an existing active deposit address when creating a virtual account", async () => {
    mockFindActiveDepositAddress.mockResolvedValue({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xabc",
      ibexReceiveInfoId: "receive-1",
    })

    const result = await BridgeService.createVirtualAccount("acct-1" as any)

    expect(mockCreateEthUsdtReceiveAddress).not.toHaveBeenCalled()
    expect(mockUpsertDepositAddress).not.toHaveBeenCalled()
    expect(mockCreateVirtualAccount).toHaveBeenCalledWith(
      "cust-1",
      expect.objectContaining({
        source: { currency: "usd" },
        destination: {
          currency: "usdt",
          payment_rail: "ethereum",
          address: "0xabc",
        },
      }),
    )
    expect(result).toEqual({
      virtualAccountId: "va-1",
      bankName: "Bridge Bank",
      routingNumber: "021000021",
      accountNumberLast4: "6789",
    })
  })

  it("creates and stores a new ETH USDT deposit address when none exists", async () => {
    mockFindActiveDepositAddress.mockResolvedValue(null)
    mockListByAccountId.mockResolvedValue([
      { id: "ibex-wallet-1", currency: "USD" },
    ])
    mockCreateEthUsdtReceiveAddress.mockResolvedValue({
      id: "receive-2",
      wallet_id: "ibex-wallet-1",
      option_id: "opt-eth-usdt",
      address: "0xdef",
      currency: "usdt",
      network: "ethereum",
      created_at: new Date().toISOString(),
    })
    mockUpsertDepositAddress.mockResolvedValue({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xdef",
      ibexReceiveInfoId: "receive-2",
    })

    const result = await BridgeService.createVirtualAccount("acct-1" as any)

    expect(mockListByAccountId).toHaveBeenCalledWith("acct-1")
    expect(mockCreateEthUsdtReceiveAddress).toHaveBeenCalledWith("ibex-wallet-1")
    expect(mockUpsertDepositAddress).toHaveBeenCalledWith({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xdef",
      ibexReceiveInfoId: "receive-2",
    })
    expect(mockCreateVirtualAccount).toHaveBeenCalledWith(
      "cust-1",
      expect.objectContaining({
        destination: {
          currency: "usdt",
          payment_rail: "ethereum",
          address: "0xdef",
        },
      }),
    )
    expect(result).toEqual({
      virtualAccountId: "va-1",
      bankName: "Bridge Bank",
      routingNumber: "021000021",
      accountNumberLast4: "6789",
    })
  })

  it("uses the stored deposit address when initiating a withdrawal", async () => {
    mockFindActiveDepositAddress.mockResolvedValue({
      accountId: "acct-1",
      rail: "ethereum",
      currency: "usdt",
      address: "0xabc",
      ibexReceiveInfoId: "receive-1",
    })

    const result = await BridgeService.initiateWithdrawal(
      "acct-1" as any,
      "25",
      "ext-1",
    )

    expect(mockCreateTransfer).toHaveBeenCalledWith(
      "cust-1",
      expect.objectContaining({
        amount: "25",
        source: {
          payment_rail: "ethereum",
          currency: "usdt",
          from_address: "0xabc",
        },
        destination: {
          payment_rail: "ach",
          currency: "usd",
          external_account_id: "ext-1",
        },
      }),
    )
    expect(result).toEqual({
      transferId: "tr-1",
      amount: "25",
      currency: "usdt",
      state: "pending",
    })
  })
})
