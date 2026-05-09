import crypto from "crypto"

jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: ({
    fns,
  }: {
    namespace: string
    fns: Record<string, (...args: unknown[]) => unknown>
  }) => fns,
}))

jest.mock("@config", () => ({
  BridgeConfig: { enabled: true, minWithdrawalAmount: 10 },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({
  createVirtualAccount: jest.fn(),
  findVirtualAccountByAccountId: jest.fn(),
  createWithdrawal: jest.fn(),
  findPendingWithdrawalWithoutTransfer: jest.fn(),
  findExternalAccountsByAccountId: jest.fn(),
  updateWithdrawalTransferId: jest.fn(),
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: { createVirtualAccount: jest.fn(), createTransfer: jest.fn() },
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getEthereumUsdtOption: jest.fn(),
    createCryptoReceiveInfo: jest.fn(),
  },
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/wallets", () => ({
  WalletsRepository: jest.fn(),
}))

jest.mock("@app/wallets/get-balance-for-wallet", () => ({
  getBalanceForWallet: jest.fn(),
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: jest.fn(),
}))

jest.mock("@domain/primitives/bridge", () => ({
  toBridgeCustomerId: (id: string) => id,
  toBridgeExternalAccountId: (id: string) => id,
}))

// USDTAmount is not re-exported from @domain/shared — provide a minimal stand-in so the
// service's `instanceof USDTAmount` guard is satisfied during tests.
// The class is defined inside the factory because jest.mock factories are hoisted before
// variable declarations; access it at runtime via require("@domain/shared").USDTAmount.
// USDTAmount is not re-exported from @domain/shared/index.ts (pre-existing issue).
// Spread the real module and inject a minimal stand-in so the service's
// `instanceof USDTAmount` guard is satisfied without breaking other domain exports.
jest.mock("@domain/shared", () => {
  class USDTAmount {
    constructor(private readonly ibexValue: number) {}
    toIbex() {
      return this.ibexValue
    }
  }
  return { ...jest.requireActual("@domain/shared"), USDTAmount }
})

import BridgeService, { deriveWithdrawalIdempotencyKey } from "@services/bridge"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import BridgeClient from "@services/bridge/client"
import { AccountsRepository } from "@services/mongoose/accounts"
import { WalletsRepository } from "@services/mongoose/wallets"
import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import IbexClient from "@services/ibex/client"
import { RepositoryError } from "@domain/errors"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = "account-001" as AccountId
const EXTERNAL_ACCOUNT_ID = "ext-account-001"
const AMOUNT = "50"
const CUSTOMER_ID = "cust-001"
const ETHEREUM_ADDRESS = "ETH_ADDR_001"
const TRANSFER_ID = "transfer-bridge-001"
const USDT_WALLET_ID = "ibex-eth-usdt-wallet-001"
const RECEIVE_INFO_ID = "receive-info-001"
const VIRTUAL_ACCOUNT_ID = "virtual-account-001"

const mockAccount = {
  id: ACCOUNT_ID,
  level: 2,
  bridgeCustomerId: CUSTOMER_ID,
  bridgeEthereumAddress: ETHEREUM_ADDRESS,
  bridgeKycStatus: "approved",
  kratosUserId: "kratos-001",
}

const makeRow = (id: string) => ({
  id,
  accountId: ACCOUNT_ID as string,
  amount: AMOUNT,
  currency: "usdt",
  externalAccountId: EXTERNAL_ACCOUNT_ID,
  status: "pending" as const,
  bridgeTransferId: undefined,
})

const mockTransfer = {
  id: TRANSFER_ID,
  amount: AMOUNT,
  currency: "usd",
  state: "pending",
}

const mockVirtualAccount = {
  id: VIRTUAL_ACCOUNT_ID,
  source_deposit_instructions: {
    bank_name: "Test Bank",
    bank_routing_number: "123456789",
    bank_account_number: "123456789012",
  },
}

const makeWallet = (id: string, currency: string) => ({
  id,
  accountId: ACCOUNT_ID,
  type: "checking",
  currency,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const setupGuards = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { USDTAmount } = require("@domain/shared")
  const balance = new USDTAmount(1000) // 1000 USDT — well above minWithdrawalAmount

  ;(AccountsRepository as jest.Mock).mockReturnValue({
    findById: jest.fn().mockResolvedValue(mockAccount),
  })
  ;(WalletsRepository as jest.Mock).mockReturnValue({
    listByAccountId: jest.fn().mockResolvedValue([{ id: "wallet-001", currency: "USDT" }]),
  })
  ;(getBalanceForWallet as jest.Mock).mockResolvedValue(balance)
  ;(BridgeAccountsRepo.findExternalAccountsByAccountId as jest.Mock).mockResolvedValue([
    { bridgeExternalAccountId: EXTERNAL_ACCOUNT_ID, status: "verified" },
  ])
  ;(BridgeAccountsRepo.updateWithdrawalTransferId as jest.Mock).mockResolvedValue({
    ...makeRow("any"),
    bridgeTransferId: TRANSFER_ID,
  })
  ;(BridgeClient.createTransfer as jest.Mock).mockResolvedValue(mockTransfer)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("deriveWithdrawalIdempotencyKey", () => {
  it("returns sha256(\"withdrawal:<rowId>\") as a hex string", () => {
    const rowId = "507f1f77bcf86cd799439011"
    const expected = crypto
      .createHash("sha256")
      .update(`withdrawal:${rowId}`)
      .digest("hex")

    expect(deriveWithdrawalIdempotencyKey(rowId)).toBe(expected)
  })

  it("produces distinct keys for distinct row IDs", () => {
    expect(deriveWithdrawalIdempotencyKey("id-alpha")).not.toBe(
      deriveWithdrawalIdempotencyKey("id-beta"),
    )
  })

  it("is deterministic — same input always returns same output", () => {
    const rowId = "507f1f77bcf86cd799439011"
    expect(deriveWithdrawalIdempotencyKey(rowId)).toBe(deriveWithdrawalIdempotencyKey(rowId))
  })

  it("output is a 64-character lowercase hex string (sha256)", () => {
    const key = deriveWithdrawalIdempotencyKey("any-id")
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("createVirtualAccount — ETH-USDT Cash Wallet provisioning", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("creates an IBEX ETH-USDT wallet, flips the default wallet, then creates the Bridge virtual account against its Ethereum receive address", async () => {
    const usdtWallet = makeWallet(USDT_WALLET_ID, "USDT")
    const accountWithoutUsdt = {
      ...mockAccount,
      defaultWalletId: "legacy-usd-wallet-id",
      bridgeEthereumAddress: undefined,
    }

    const accountsRepo = {
      findById: jest.fn().mockResolvedValue(accountWithoutUsdt),
      update: jest.fn().mockResolvedValue({
        ...accountWithoutUsdt,
        defaultWalletId: USDT_WALLET_ID,
      }),
      updateBridgeFields: jest.fn().mockResolvedValue({
        ...accountWithoutUsdt,
        defaultWalletId: USDT_WALLET_ID,
        bridgeEthereumAddress: ETHEREUM_ADDRESS,
      }),
    }
    ;(AccountsRepository as jest.Mock).mockReturnValue(accountsRepo)
    ;(WalletsRepository as jest.Mock).mockReturnValue({
      listByAccountId: jest.fn().mockResolvedValue([makeWallet("legacy-usd-wallet-id", "USD")]),
      persistNew: jest.fn().mockResolvedValue(usdtWallet),
    })
    ;(BridgeAccountsRepo.findVirtualAccountByAccountId as jest.Mock).mockResolvedValue(
      new RepositoryError("not found"),
    )
    ;(IbexClient.getEthereumUsdtOption as jest.Mock).mockResolvedValue({
      id: "eth-usdt-option",
      currency: "USDT",
      network: "ethereum",
      name: "Ethereum USDT",
    })
    ;(IbexClient.createCryptoReceiveInfo as jest.Mock).mockResolvedValue({
      id: RECEIVE_INFO_ID,
      wallet_id: USDT_WALLET_ID,
      option_id: "eth-usdt-option",
      address: ETHEREUM_ADDRESS,
      currency: "USDT",
      network: "ethereum",
      created_at: "2026-05-09T00:00:00Z",
    })
    ;(BridgeClient.createVirtualAccount as jest.Mock).mockResolvedValue(mockVirtualAccount)
    ;(BridgeAccountsRepo.createVirtualAccount as jest.Mock).mockResolvedValue({
      bridgeVirtualAccountId: VIRTUAL_ACCOUNT_ID,
    })

    await BridgeService.createVirtualAccount(ACCOUNT_ID)

    expect(WalletsRepository().persistNew).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      type: "checking",
      currency: "USDT",
    })
    expect(AccountsRepository().update).toHaveBeenCalledWith(
      expect.objectContaining({ defaultWalletId: USDT_WALLET_ID }),
    )
    expect(IbexClient.createCryptoReceiveInfo).toHaveBeenCalledWith(
      USDT_WALLET_ID,
      expect.objectContaining({ network: "ethereum", currency: "USDT" }),
    )
    expect(BridgeClient.createVirtualAccount).toHaveBeenCalledWith(
      CUSTOMER_ID,
      expect.objectContaining({
        destination: expect.objectContaining({
          currency: "usdt",
          payment_rail: "ethereum",
          address: ETHEREUM_ADDRESS,
        }),
      }),
      expect.any(String),
    )
  })

  it("reuses an existing USDT wallet and existing Ethereum address without reprovisioning", async () => {
    const usdtWallet = makeWallet(USDT_WALLET_ID, "USDT")
    const accountWithUsdtDefault = {
      ...mockAccount,
      defaultWalletId: USDT_WALLET_ID,
      bridgeEthereumAddress: ETHEREUM_ADDRESS,
    }

    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue(accountWithUsdtDefault),
      update: jest.fn(),
      updateBridgeFields: jest.fn(),
    })
    ;(WalletsRepository as jest.Mock).mockReturnValue({
      listByAccountId: jest.fn().mockResolvedValue([usdtWallet]),
      persistNew: jest.fn(),
    })
    ;(BridgeAccountsRepo.findVirtualAccountByAccountId as jest.Mock).mockResolvedValue(
      new RepositoryError("not found"),
    )
    ;(BridgeClient.createVirtualAccount as jest.Mock).mockResolvedValue(mockVirtualAccount)
    ;(BridgeAccountsRepo.createVirtualAccount as jest.Mock).mockResolvedValue({
      bridgeVirtualAccountId: VIRTUAL_ACCOUNT_ID,
    })

    await BridgeService.createVirtualAccount(ACCOUNT_ID)

    expect(WalletsRepository().persistNew).not.toHaveBeenCalled()
    expect(AccountsRepository().update).not.toHaveBeenCalled()
    expect(IbexClient.createCryptoReceiveInfo).not.toHaveBeenCalled()
    expect(BridgeClient.createVirtualAccount).toHaveBeenCalledWith(
      CUSTOMER_ID,
      expect.objectContaining({
        destination: expect.objectContaining({ address: ETHEREUM_ADDRESS }),
      }),
      expect.any(String),
    )
  })
})

describe("initiateWithdrawal — idempotency key wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupGuards()
  })

  describe("fresh request (no in-flight row)", () => {
    it("creates a pending withdrawal row before calling Bridge", async () => {
      const row = makeRow("fresh-row-001")
      ;(BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer as jest.Mock).mockResolvedValue(
        null,
      )
      ;(BridgeAccountsRepo.createWithdrawal as jest.Mock).mockResolvedValue(row)

      await BridgeService.initiateWithdrawal(ACCOUNT_ID, AMOUNT, EXTERNAL_ACCOUNT_ID)

      const createOrder = (BridgeAccountsRepo.createWithdrawal as jest.Mock).mock
        .invocationCallOrder[0]
      const transferOrder = (BridgeClient.createTransfer as jest.Mock).mock.invocationCallOrder[0]
      expect(createOrder).toBeLessThan(transferOrder)
    })

    it("derives the idempotency key from the newly created row's id", async () => {
      const rowId = "fresh-row-id-abc"
      ;(BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer as jest.Mock).mockResolvedValue(
        null,
      )
      ;(BridgeAccountsRepo.createWithdrawal as jest.Mock).mockResolvedValue(makeRow(rowId))

      await BridgeService.initiateWithdrawal(ACCOUNT_ID, AMOUNT, EXTERNAL_ACCOUNT_ID)

      const expectedKey = deriveWithdrawalIdempotencyKey(rowId)
      expect(BridgeClient.createTransfer).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.any(Object),
        expectedKey,
      )
    })
  })

  describe("retry — in-flight row already exists", () => {
    it("does not create a second withdrawal row", async () => {
      const existingRow = makeRow("existing-row-001")
      ;(BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer as jest.Mock).mockResolvedValue(
        existingRow,
      )

      await BridgeService.initiateWithdrawal(ACCOUNT_ID, AMOUNT, EXTERNAL_ACCOUNT_ID)

      expect(BridgeAccountsRepo.createWithdrawal).not.toHaveBeenCalled()
    })

    it("derives the key from the existing row's id — identical to the first attempt's key", async () => {
      const rowId = "existing-row-001"
      ;(BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer as jest.Mock).mockResolvedValue(
        makeRow(rowId),
      )

      await BridgeService.initiateWithdrawal(ACCOUNT_ID, AMOUNT, EXTERNAL_ACCOUNT_ID)

      const expectedKey = deriveWithdrawalIdempotencyKey(rowId)
      expect(BridgeClient.createTransfer).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.any(Object),
        expectedKey,
      )
    })
  })

  describe("two rapid calls for the same request", () => {
    it("pass the same idempotency key to Bridge — collapsing into one transfer", async () => {
      // Call 1: no in-flight row → creates row A
      // Call 2: finds row A (created by call 1) → reuses its id
      const rowId = "shared-row-concurrent"
      const row = makeRow(rowId)

      ;(BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer as jest.Mock)
        .mockResolvedValueOnce(null) // call 1: nothing in-flight yet
        .mockResolvedValueOnce(row)  // call 2: row A now visible

      ;(BridgeAccountsRepo.createWithdrawal as jest.Mock).mockResolvedValue(row)

      await BridgeService.initiateWithdrawal(ACCOUNT_ID, AMOUNT, EXTERNAL_ACCOUNT_ID)
      await BridgeService.initiateWithdrawal(ACCOUNT_ID, AMOUNT, EXTERNAL_ACCOUNT_ID)

      const calls = (BridgeClient.createTransfer as jest.Mock).mock.calls
      expect(calls).toHaveLength(2)

      const key1 = calls[0][2]
      const key2 = calls[1][2]
      expect(key1).toBe(key2)
      expect(key1).toBe(deriveWithdrawalIdempotencyKey(rowId))
    })
  })
})
