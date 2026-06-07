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
  // Minimal stubs so schema.ts can run its module-level initialisation
  getFeesConfig: jest.fn().mockReturnValue({ depositFeeVariable: 0, depositFeeFixed: 0, withdrawFeeVariable: 0, withdrawFeeFixed: 0 }),
  getDefaultAccountsConfig: jest.fn().mockReturnValue({ initialStatus: "active", initialLevel: 0, maxCurrencies: 5 }),
  getDefaultFCMTopics: jest.fn().mockReturnValue([]),
  Levels: [0, 1, 2, 3],
  getI18nInstance: jest.fn().mockReturnValue({ __: jest.fn() }),
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
  findWithdrawalById: jest.fn(),
  findWithdrawalsByAccountId: jest.fn(),
  cancelWithdrawal: jest.fn(),
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: {
    createVirtualAccount: jest.fn(),
    createTransfer: jest.fn(),
    getCustomer: jest.fn().mockResolvedValue({ status: "active" }),
  },
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

// USDTAmount stand-in: the real type is not exported from @domain/shared.
// We spread the real module and inject a minimal class so `instanceof USDTAmount`
// guards in the service are satisfied during tests.
jest.mock("@domain/shared", () => {
  class USDTAmount {
    constructor(private readonly ibexValue: number) {}
    toIbex() {
      return this.ibexValue
    }
  }
  return { ...jest.requireActual("@domain/shared"), USDTAmount }
})

jest.mock("@app/bridge/send-withdrawal-notification", () => ({
  sendBridgeWithdrawalNotificationBestEffort: jest.fn().mockResolvedValue(undefined),
}))

import BridgeService, { deriveWithdrawalIdempotencyKey } from "@services/bridge"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import BridgeClient from "@services/bridge/client"
import { AccountsRepository } from "@services/mongoose/accounts"
import { WalletsRepository } from "@services/mongoose/wallets"
import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import IbexClient from "@services/ibex/client"
import { RepositoryError } from "@domain/errors"
import { sendBridgeWithdrawalNotificationBestEffort } from "@app/bridge/send-withdrawal-notification"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = "account-001" as AccountId
const EXTERNAL_ACCOUNT_ID = "ext-account-001"
const AMOUNT = "50"
const CUSTOMER_ID = "cust-001"
const ETHEREUM_ADDRESS = "ETH_ADDR_001"
const TRANSFER_ID = "transfer-bridge-001"
const WITHDRAWAL_ID = "withdrawal-mongo-001"
const USDT_WALLET_ID = "ibex-eth-usdt-wallet-001"
const RECEIVE_INFO_ID = "receive-info-001"
const VIRTUAL_ACCOUNT_ID = "virtual-account-001"
const CREATED_AT = new Date("2026-01-01T00:00:00Z")

const mockAccount = {
  id: ACCOUNT_ID,
  level: 2,
  bridgeCustomerId: CUSTOMER_ID,
  bridgeEthereumAddress: ETHEREUM_ADDRESS,
  bridgeKycStatus: "approved",
  kratosUserId: "kratos-001",
}

const makeRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  accountId: ACCOUNT_ID as string,
  amount: AMOUNT,
  currency: "usdt",
  externalAccountId: EXTERNAL_ACCOUNT_ID,
  status: "pending" as const,
  bridgeTransferId: undefined,
  failureReason: undefined,
  createdAt: CREATED_AT,
  ...overrides,
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

const getUSDTAmount = (ibex: number) => {
  const { USDTAmount } = jest.requireMock("@domain/shared") as {
    USDTAmount: new (ibexValue: number) => { toIbex: () => number }
  }
  return new USDTAmount(ibex)
}

/** Sets up the guards common to requestWithdrawal and initiateWithdrawal. */
const setupGuards = () => {
  ;(AccountsRepository as jest.Mock).mockReturnValue({
    findById: jest.fn().mockResolvedValue(mockAccount),
    update: jest.fn(),
    updateBridgeFields: jest.fn(),
  })
  ;(WalletsRepository as jest.Mock).mockReturnValue({
    listByAccountId: jest.fn().mockResolvedValue([
      { id: USDT_WALLET_ID, currency: "USDT", type: "checking" },
    ]),
    persistNew: jest.fn(),
  })
  ;(getBalanceForWallet as jest.Mock).mockResolvedValue(getUSDTAmount(1000))
  ;(BridgeAccountsRepo.findExternalAccountsByAccountId as jest.Mock).mockResolvedValue([
    { bridgeExternalAccountId: EXTERNAL_ACCOUNT_ID, status: "verified" },
  ])
  ;(BridgeAccountsRepo.updateWithdrawalTransferId as jest.Mock).mockResolvedValue({
    ...makeRow(WITHDRAWAL_ID),
    bridgeTransferId: TRANSFER_ID,
    status: "submitted" as const,
  })
  ;(BridgeClient.createTransfer as jest.Mock).mockResolvedValue(mockTransfer)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("deriveWithdrawalIdempotencyKey", () => {
  it('returns sha256("withdrawal:<rowId>") as a hex string', () => {
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
    expect(deriveWithdrawalIdempotencyKey(rowId)).toBe(
      deriveWithdrawalIdempotencyKey(rowId),
    )
  })

  it("output is a 64-character lowercase hex string (sha256)", () => {
    const key = deriveWithdrawalIdempotencyKey("any-id")
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })
})

/**
 * Linear ENG-296 — ETH-USDT Cash Wallet + Bridge virtual account
 */
describe("createVirtualAccount — ETH-USDT Cash Wallet provisioning (ENG-296)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("ENG-296 AC1+AC2+AC3: provisions USDT cash wallet, flips default off USD, persists Ibex ETH receive address, creates Bridge VA", async () => {
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
      data: { address: ETHEREUM_ADDRESS },
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
    expect(accountsRepo.updateBridgeFields).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ bridgeEthereumAddress: ETHEREUM_ADDRESS }),
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

  it("ENG-296 AC1+AC3: reuses existing USDT cash wallet and stored Ethereum address (no extra Ibex receive-info call)", async () => {
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

  it("ENG-296 AC3 (idempotent): existing VA returns stored bank details without wallet or Ibex side effects", async () => {
    const existingVaRecord = {
      bridgeVirtualAccountId: VIRTUAL_ACCOUNT_ID,
      bankName: "Existing Bank",
      routingNumber: "021000021",
      accountNumber: "000111222",
      accountNumberLast4: "0222",
    }

    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue(mockAccount),
      update: jest.fn(),
      updateBridgeFields: jest.fn(),
    })
    ;(WalletsRepository as jest.Mock).mockReturnValue({
      listByAccountId: jest.fn(),
      persistNew: jest.fn(),
    })
    ;(BridgeAccountsRepo.findVirtualAccountByAccountId as jest.Mock).mockResolvedValue(
      existingVaRecord,
    )

    const result = await BridgeService.createVirtualAccount(ACCOUNT_ID)

    expect(result).toEqual(
      expect.objectContaining({
        virtualAccountId: VIRTUAL_ACCOUNT_ID,
        bankName: "Existing Bank",
        routingNumber: "021000021",
        accountNumber: "000111222",
        accountNumberLast4: "0222",
      }),
    )
    expect(WalletsRepository().listByAccountId).not.toHaveBeenCalled()
    expect(WalletsRepository().persistNew).not.toHaveBeenCalled()
    expect(AccountsRepository().update).not.toHaveBeenCalled()
    expect(IbexClient.getEthereumUsdtOption).not.toHaveBeenCalled()
    expect(IbexClient.createCryptoReceiveInfo).not.toHaveBeenCalled()
    expect(BridgeClient.createVirtualAccount).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// requestWithdrawal
// Step 1 of the split flow: validates everything and writes a pending MongoDB
// record — does NOT call the Bridge API.
// ─────────────────────────────────────────────────────────────────────────────

describe("requestWithdrawal", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupGuards()
    ;(BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer as jest.Mock).mockResolvedValue(
      null,
    )
    ;(BridgeAccountsRepo.createWithdrawal as jest.Mock).mockResolvedValue(
      makeRow(WITHDRAWAL_ID),
    )
  })

  it("creates a pending withdrawal record and returns the full result", async () => {
    const result = await BridgeService.requestWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    expect(result).not.toBeInstanceOf(Error)
    expect(BridgeAccountsRepo.createWithdrawal).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID as string,
      amount: AMOUNT,
      currency: "usdt",
      externalAccountId: EXTERNAL_ACCOUNT_ID,
      status: "pending",
    })
    if (!(result instanceof Error)) {
      expect(result.id).toBe(WITHDRAWAL_ID)
      expect(result.amount).toBe(AMOUNT)
      expect(result.currency).toBe("usdt")
      expect(result.externalAccountId).toBe(EXTERNAL_ACCOUNT_ID)
      expect(result.status).toBe("pending")
      expect(result.createdAt).toBeDefined()
    }
  })

  it("never calls the Bridge API", async () => {
    await BridgeService.requestWithdrawal(ACCOUNT_ID, AMOUNT, EXTERNAL_ACCOUNT_ID)
    expect(BridgeClient.createTransfer).not.toHaveBeenCalled()
  })

  it("reuses an existing pending withdrawal for the same account, amount, and external account", async () => {
    const existingRow = makeRow("withdrawal-existing-001")
    ;(BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer as jest.Mock).mockResolvedValue(
      existingRow,
    )

    const result = await BridgeService.requestWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    expect(BridgeAccountsRepo.createWithdrawal).not.toHaveBeenCalled()
    expect(result).not.toBeInstanceOf(Error)
    if (!(result instanceof Error)) {
      expect(result.id).toBe("withdrawal-existing-001")
      expect(result.status).toBe("pending")
    }
  })

  it("returns an error when the external account does not belong to the caller (CRIT-2)", async () => {
    ;(BridgeAccountsRepo.findExternalAccountsByAccountId as jest.Mock).mockResolvedValue([
      { bridgeExternalAccountId: "somebody-elses-account", status: "verified" },
    ])

    const result = await BridgeService.requestWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    expect(result).toBeInstanceOf(Error)
    expect(BridgeAccountsRepo.createWithdrawal).not.toHaveBeenCalled()
  })

  it("returns an error when the external account is not yet verified", async () => {
    ;(BridgeAccountsRepo.findExternalAccountsByAccountId as jest.Mock).mockResolvedValue([
      { bridgeExternalAccountId: EXTERNAL_ACCOUNT_ID, status: "pending" },
    ])

    const result = await BridgeService.requestWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    expect(result).toBeInstanceOf(Error)
    expect(BridgeAccountsRepo.createWithdrawal).not.toHaveBeenCalled()
  })

  it("returns BridgeInsufficientFundsError when USDT balance is below the requested amount", async () => {
    ;(getBalanceForWallet as jest.Mock).mockResolvedValue(getUSDTAmount(5)) // < AMOUNT=50

    const result = await BridgeService.requestWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    const { BridgeInsufficientFundsError } = jest.requireActual("@services/bridge/errors")
    expect(result).toBeInstanceOf(BridgeInsufficientFundsError)
    expect(BridgeAccountsRepo.createWithdrawal).not.toHaveBeenCalled()
  })

  it("returns BridgeCustomerNotFoundError when account has no Bridge customer ID", async () => {
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue({ ...mockAccount, bridgeCustomerId: undefined }),
    })

    const result = await BridgeService.requestWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    const { BridgeCustomerNotFoundError } = jest.requireActual("@services/bridge/errors")
    expect(result).toBeInstanceOf(BridgeCustomerNotFoundError)
  })

  it("returns an error when account has no Ethereum address", async () => {
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue({
        ...mockAccount,
        bridgeEthereumAddress: undefined,
      }),
    })

    const result = await BridgeService.requestWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    expect(result).toBeInstanceOf(Error)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// initiateWithdrawal (refactored)
// Step 2A: fetches the pending record by ID, re-checks balance, calls Bridge.
// ─────────────────────────────────────────────────────────────────────────────

describe("initiateWithdrawal — takes withdrawalId (step 2A)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupGuards()
    ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(
      makeRow(WITHDRAWAL_ID),
    )
  })

  it("fetches the pending withdrawal from MongoDB before calling Bridge", async () => {
    await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    expect(BridgeAccountsRepo.findWithdrawalById).toHaveBeenCalledWith(WITHDRAWAL_ID)
  })

  it("never calls createWithdrawal — the row already exists from requestWithdrawal", async () => {
    await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    expect(BridgeAccountsRepo.createWithdrawal).not.toHaveBeenCalled()
  })

  it("uses the idempotency key derived from the withdrawalId", async () => {
    await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    const expectedKey = deriveWithdrawalIdempotencyKey(WITHDRAWAL_ID)
    expect(BridgeClient.createTransfer).toHaveBeenCalledWith(
      CUSTOMER_ID,
      expect.any(Object),
      expectedKey,
    )
  })

  it("calling twice with the same withdrawalId passes the same idempotency key to Bridge", async () => {
    await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)
    await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    const calls = (BridgeClient.createTransfer as jest.Mock).mock.calls
    expect(calls[0][2]).toBe(calls[1][2])
    expect(calls[0][2]).toBe(deriveWithdrawalIdempotencyKey(WITHDRAWAL_ID))
  })

  it("updates the withdrawal record with the Bridge transfer ID and transitions status to submitted", async () => {
    const result = await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    expect(BridgeAccountsRepo.updateWithdrawalTransferId).toHaveBeenCalledWith(
      WITHDRAWAL_ID,
      TRANSFER_ID,
      AMOUNT,
      "usd",
    )
    expect(result).not.toBeInstanceOf(Error)
    if (!(result instanceof Error)) {
      expect(result.status).toBe("submitted")
      expect(result.bridgeTransferId).toBe(TRANSFER_ID)
    }
  })

  it("returns BridgeWithdrawalNotFoundError when the withdrawal ID does not exist", async () => {
    ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(
      new RepositoryError("Withdrawal not found"),
    )

    const result = await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    const { BridgeWithdrawalNotFoundError } = jest.requireActual("@services/bridge/errors")
    expect(result).toBeInstanceOf(BridgeWithdrawalNotFoundError)
    expect(BridgeClient.createTransfer).not.toHaveBeenCalled()
  })

  it("returns BridgeWithdrawalNotFoundError when the withdrawal belongs to a different account", async () => {
    ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(
      makeRow(WITHDRAWAL_ID, { accountId: "different-account" }),
    )

    const result = await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    const { BridgeWithdrawalNotFoundError } = jest.requireActual("@services/bridge/errors")
    expect(result).toBeInstanceOf(BridgeWithdrawalNotFoundError)
    expect(BridgeClient.createTransfer).not.toHaveBeenCalled()
  })

  it("returns BridgeWithdrawalAlreadyInitiatedError when bridgeTransferId is already set", async () => {
    ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(
      makeRow(WITHDRAWAL_ID, { bridgeTransferId: "already-submitted" }),
    )

    const result = await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    const { BridgeWithdrawalAlreadyInitiatedError } = jest.requireActual(
      "@services/bridge/errors",
    )
    expect(result).toBeInstanceOf(BridgeWithdrawalAlreadyInitiatedError)
    expect(BridgeClient.createTransfer).not.toHaveBeenCalled()
  })

  it("returns BridgeWithdrawalAlreadyInitiatedError when status is not pending", async () => {
    ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(
      makeRow(WITHDRAWAL_ID, { status: "cancelled" }),
    )

    const result = await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    const { BridgeWithdrawalAlreadyInitiatedError } = jest.requireActual(
      "@services/bridge/errors",
    )
    expect(result).toBeInstanceOf(BridgeWithdrawalAlreadyInitiatedError)
    expect(BridgeClient.createTransfer).not.toHaveBeenCalled()
  })

  it("returns BridgeInsufficientFundsError when balance dropped between request and initiate", async () => {
    ;(getBalanceForWallet as jest.Mock).mockResolvedValue(getUSDTAmount(5)) // < AMOUNT=50

    const result = await BridgeService.initiateWithdrawal(ACCOUNT_ID, WITHDRAWAL_ID)

    const { BridgeInsufficientFundsError } = jest.requireActual("@services/bridge/errors")
    expect(result).toBeInstanceOf(BridgeInsufficientFundsError)
    expect(BridgeClient.createTransfer).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// cancelWithdrawalRequest
// Step 2B: marks the pending record "cancelled" and sends a push notification.
// Only allowed before the Bridge API has been called (no bridgeTransferId).
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelWithdrawalRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue(mockAccount),
    })
    ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(
      makeRow(WITHDRAWAL_ID),
    )
    ;(BridgeAccountsRepo.cancelWithdrawal as jest.Mock).mockResolvedValue(
      makeRow(WITHDRAWAL_ID, { status: "cancelled" }),
    )
  })

  it("cancels the pending withdrawal and returns status cancelled", async () => {
    const result = await BridgeService.cancelWithdrawalRequest(ACCOUNT_ID, WITHDRAWAL_ID)

    expect(result).not.toBeInstanceOf(Error)
    if (!(result instanceof Error)) {
      expect(result.status).toBe("cancelled")
      expect(result.id).toBe(WITHDRAWAL_ID)
      expect(result.amount).toBe(AMOUNT)
    }
  })

  it("calls cancelWithdrawal with the correct accountId and withdrawalId", async () => {
    await BridgeService.cancelWithdrawalRequest(ACCOUNT_ID, WITHDRAWAL_ID)

    expect(BridgeAccountsRepo.cancelWithdrawal).toHaveBeenCalledWith(
      ACCOUNT_ID as string,
      WITHDRAWAL_ID,
    )
  })

  it("never calls the Bridge API", async () => {
    await BridgeService.cancelWithdrawalRequest(ACCOUNT_ID, WITHDRAWAL_ID)

    expect(BridgeClient.createTransfer).not.toHaveBeenCalled()
  })

  it("sends a cancelled push notification after a successful cancel", async () => {
    await BridgeService.cancelWithdrawalRequest(ACCOUNT_ID, WITHDRAWAL_ID)

    expect(sendBridgeWithdrawalNotificationBestEffort).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID as string,
      amount: AMOUNT,
      currency: "usdt",
      outcome: "cancelled",
    })
  })

  it("returns BridgeWithdrawalNotFoundError when the withdrawal ID does not exist", async () => {
    ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(
      new RepositoryError("Withdrawal not found"),
    )

    const result = await BridgeService.cancelWithdrawalRequest(ACCOUNT_ID, WITHDRAWAL_ID)

    const { BridgeWithdrawalNotFoundError } = jest.requireActual("@services/bridge/errors")
    expect(result).toBeInstanceOf(BridgeWithdrawalNotFoundError)
    expect(sendBridgeWithdrawalNotificationBestEffort).not.toHaveBeenCalled()
  })

  it("returns BridgeWithdrawalNotFoundError when the withdrawal belongs to a different account", async () => {
    ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(
      makeRow(WITHDRAWAL_ID, { accountId: "different-account" }),
    )

    const result = await BridgeService.cancelWithdrawalRequest(ACCOUNT_ID, WITHDRAWAL_ID)

    const { BridgeWithdrawalNotFoundError } = jest.requireActual("@services/bridge/errors")
    expect(result).toBeInstanceOf(BridgeWithdrawalNotFoundError)
    expect(sendBridgeWithdrawalNotificationBestEffort).not.toHaveBeenCalled()
  })

  it("returns BridgeWithdrawalAlreadyInitiatedError when the transfer was already submitted to Bridge", async () => {
    ;(BridgeAccountsRepo.findWithdrawalById as jest.Mock).mockResolvedValue(
      makeRow(WITHDRAWAL_ID, { bridgeTransferId: "already-submitted-id" }),
    )

    const result = await BridgeService.cancelWithdrawalRequest(ACCOUNT_ID, WITHDRAWAL_ID)

    const { BridgeWithdrawalAlreadyInitiatedError } = jest.requireActual(
      "@services/bridge/errors",
    )
    expect(result).toBeInstanceOf(BridgeWithdrawalAlreadyInitiatedError)
    expect(BridgeAccountsRepo.cancelWithdrawal).not.toHaveBeenCalled()
    expect(sendBridgeWithdrawalNotificationBestEffort).not.toHaveBeenCalled()
  })

  it("does not send a notification when the repo cancelWithdrawal fails (e.g. race condition)", async () => {
    ;(BridgeAccountsRepo.cancelWithdrawal as jest.Mock).mockResolvedValue(
      new RepositoryError("Withdrawal not found or cannot be cancelled"),
    )

    const result = await BridgeService.cancelWithdrawalRequest(ACCOUNT_ID, WITHDRAWAL_ID)

    const { BridgeWithdrawalNotFoundError } = jest.requireActual("@services/bridge/errors")
    expect(result).toBeInstanceOf(BridgeWithdrawalNotFoundError)
    expect(sendBridgeWithdrawalNotificationBestEffort).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getWithdrawals
// Returns the account's withdrawal history mapped to the GQL-facing shape
// (id/status/bridgeTransferId — NOT the old transferId/state fields).
// ─────────────────────────────────────────────────────────────────────────────

describe("getWithdrawals", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue(mockAccount),
    })
  })

  it("maps submitted rows to id/status — not transferId or state", async () => {
    ;(BridgeAccountsRepo.findWithdrawalsByAccountId as jest.Mock).mockResolvedValue([
      makeRow(WITHDRAWAL_ID, { bridgeTransferId: TRANSFER_ID, status: "submitted" }),
    ])

    const result = await BridgeService.getWithdrawals(ACCOUNT_ID)

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(WITHDRAWAL_ID)
    expect(result[0].status).toBe("submitted")
    expect((result[0] as Record<string, unknown>).transferId).toBeUndefined()
    expect((result[0] as Record<string, unknown>).state).toBeUndefined()
  })

  it("includes bridgeTransferId for submitted/completed rows", async () => {
    ;(BridgeAccountsRepo.findWithdrawalsByAccountId as jest.Mock).mockResolvedValue([
      makeRow(WITHDRAWAL_ID, { bridgeTransferId: TRANSFER_ID, status: "completed" }),
    ])

    const result = await BridgeService.getWithdrawals(ACCOUNT_ID)

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result[0].bridgeTransferId).toBe(TRANSFER_ID)
    expect(result[0].status).toBe("completed")
  })

  it("excludes pending rows that have no bridgeTransferId (pre-initiation)", async () => {
    ;(BridgeAccountsRepo.findWithdrawalsByAccountId as jest.Mock).mockResolvedValue([
      makeRow(WITHDRAWAL_ID), // bridgeTransferId: undefined — pre-approval
    ])

    const result = await BridgeService.getWithdrawals(ACCOUNT_ID)

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result).toHaveLength(0)
  })

  it("excludes cancelled rows without a bridgeTransferId, includes submitted/completed/failed", async () => {
    ;(BridgeAccountsRepo.findWithdrawalsByAccountId as jest.Mock).mockResolvedValue([
      makeRow("w-1", { status: "pending" }),                                           // excluded
      makeRow("w-2", { status: "cancelled" }),                                         // excluded (no transferId)
      makeRow("w-3", { status: "submitted",  bridgeTransferId: TRANSFER_ID }),
      makeRow("w-4", { status: "completed",  bridgeTransferId: "t-completed" }),
      makeRow("w-5", { status: "failed",     bridgeTransferId: "t-failed" }),
    ])

    const result = await BridgeService.getWithdrawals(ACCOUNT_ID)

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result).toHaveLength(3)
    expect(result.map((r) => r.status)).toEqual(["submitted", "completed", "failed"])
  })

  it("formats createdAt as an ISO string", async () => {
    ;(BridgeAccountsRepo.findWithdrawalsByAccountId as jest.Mock).mockResolvedValue([
      makeRow(WITHDRAWAL_ID, { bridgeTransferId: TRANSFER_ID, status: "submitted" }),
    ])

    const result = await BridgeService.getWithdrawals(ACCOUNT_ID)

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result[0].createdAt).toBe(CREATED_AT.toISOString())
  })
})
