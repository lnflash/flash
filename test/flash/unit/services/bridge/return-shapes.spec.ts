/**
 * ENG-352 — Bridge service return shapes must match the public GraphQL types.
 *
 * The withdrawal mutation/query resolvers return the BridgeService result
 * directly, with no resolver-level field mapping. That makes the service the
 * source of truth for the GraphQL contract. The public `BridgeWithdrawal` type
 * requires `transferId`, `amount`, `currency`, `state`, and `createdAt`
 * (all NonNull) and exposes an optional `failureReason` (nullable).
 *
 * Regression guard: `initiateWithdrawal` previously omitted `createdAt`, which
 * resolved to `undefined` against a `GT.NonNull(GT.String)` field and raised a
 * non-null violation on the mutation response.
 */
jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: ({
    fns,
  }: {
    namespace: string
    fns: Record<string, (...args: unknown[]) => unknown>
  }) => fns,
}))

// Spread the real @config so transitive imports (e.g. mongoose schema.ts ->
// getFeesConfig) keep working, then override BridgeConfig for the guards here.
jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  BridgeConfig: { enabled: true, minWithdrawalAmount: 10 },
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

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getEthereumUsdtOption: jest.fn(),
    createCryptoReceiveInfo: jest.fn(),
  },
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({
  createWithdrawal: jest.fn(),
  findPendingWithdrawalWithoutTransfer: jest.fn(),
  findExternalAccountsByAccountId: jest.fn(),
  findWithdrawalsByAccountId: jest.fn(),
  updateWithdrawalTransferId: jest.fn(),
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: { createTransfer: jest.fn() },
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

// USDTAmount is not re-exported from @domain/shared/index.ts (pre-existing). Spread
// the real module and inject a minimal stand-in so the service's `instanceof
// USDTAmount` balance guard is satisfied without breaking other domain exports.
jest.mock("@domain/shared", () => {
  class USDTAmount {
    constructor(private readonly ibexValue: number) {
      // Parameter property initializes ibexValue.
    }
    toIbex() {
      return this.ibexValue
    }
  }
  return { ...jest.requireActual("@domain/shared"), USDTAmount }
})

import BridgeService from "@services/bridge"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import BridgeClient from "@services/bridge/client"
import { AccountsRepository } from "@services/mongoose/accounts"
import { WalletsRepository } from "@services/mongoose/wallets"
import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"

// ── Fixtures ────────────────────────────────────────────────────────────────

const ACCOUNT_ID = "account-001" as AccountId
const EXTERNAL_ACCOUNT_ID = "ext-account-001"
const AMOUNT = "50"
const CUSTOMER_ID = "cust-001"
const ETHEREUM_ADDRESS = "ETH_ADDR_001"
const TRANSFER_ID = "transfer-bridge-001"
const TRANSFER_CREATED_AT = "2026-06-05T00:00:00.000Z"

const mockAccount = {
  id: ACCOUNT_ID,
  level: 2,
  bridgeCustomerId: CUSTOMER_ID,
  bridgeEthereumAddress: ETHEREUM_ADDRESS,
  bridgeKycStatus: "approved",
  kratosUserId: "kratos-001",
}

const mockTransfer = {
  id: TRANSFER_ID,
  amount: AMOUNT,
  currency: "usd",
  state: "pending",
  created_at: TRANSFER_CREATED_AT,
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

const setupGuards = () => {
  const { USDTAmount } = jest.requireMock("@domain/shared") as {
    USDTAmount: new (ibexValue: number) => { toIbex: () => number }
  }
  const balance = new USDTAmount(1000) // 1000 USDT — well above minWithdrawalAmount

  ;(AccountsRepository as jest.Mock).mockReturnValue({
    findById: jest.fn().mockResolvedValue(mockAccount),
  })
  ;(WalletsRepository as jest.Mock).mockReturnValue({
    listByAccountId: jest
      .fn()
      .mockResolvedValue([{ id: "wallet-001", currency: "USDT", type: "checking" }]),
  })
  ;(getBalanceForWallet as jest.Mock).mockResolvedValue(balance)
  ;(BridgeAccountsRepo.findExternalAccountsByAccountId as jest.Mock).mockResolvedValue([
    { bridgeExternalAccountId: EXTERNAL_ACCOUNT_ID, status: "verified" },
  ])
  ;(
    BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer as jest.Mock
  ).mockResolvedValue(null)
  ;(BridgeAccountsRepo.createWithdrawal as jest.Mock).mockResolvedValue(
    makeRow("contract-row-001"),
  )
  ;(BridgeAccountsRepo.updateWithdrawalTransferId as jest.Mock).mockResolvedValue({
    ...makeRow("contract-row-001"),
    bridgeTransferId: TRANSFER_ID,
  })
  ;(BridgeClient.createTransfer as jest.Mock).mockResolvedValue(mockTransfer)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("initiateWithdrawal — GraphQL BridgeWithdrawal contract shape (ENG-352)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupGuards()
  })

  it("returns every NonNull field required by the BridgeWithdrawal GraphQL type", async () => {
    const result = await BridgeService.initiateWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return

    expect(result.transferId).toBe(TRANSFER_ID)
    expect(result.amount).toBe(AMOUNT)
    expect(result.currency).toBeDefined()
    expect(result.state).toBe("pending")
    expect(result.createdAt).toBe(TRANSFER_CREATED_AT)
  })

  it("populates createdAt from the Bridge transfer (NonNull field must not be undefined)", async () => {
    const result = await BridgeService.initiateWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    if (result instanceof Error) throw result
    expect(result.createdAt).toEqual(expect.any(String))
    expect(result.createdAt.length).toBeGreaterThan(0)
  })

  it("does not leak the raw Bridge transfer shape (no id/status keys)", async () => {
    const result = await BridgeService.initiateWithdrawal(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )

    if (result instanceof Error) throw result
    expect(result).not.toHaveProperty("id")
    expect(result).not.toHaveProperty("status")
  })
})

describe("getWithdrawals — GraphQL BridgeWithdrawal contract shape (ENG-352)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupGuards()
  })

  const makePersistedWithdrawal = (overrides: Record<string, unknown> = {}) => ({
    bridgeTransferId: TRANSFER_ID,
    amount: AMOUNT,
    currency: "usdt",
    status: "completed",
    failureReason: undefined,
    createdAt: new Date(TRANSFER_CREATED_AT),
    ...overrides,
  })

  it("maps persisted rows to the service contract shape (incl. createdAt + failureReason)", async () => {
    ;(BridgeAccountsRepo.findWithdrawalsByAccountId as jest.Mock).mockResolvedValue([
      makePersistedWithdrawal({ status: "failed", failureReason: "returned_by_bank" }),
    ])

    const result = await BridgeService.getWithdrawals(ACCOUNT_ID)
    if (result instanceof Error) throw result

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(
      expect.objectContaining({
        transferId: TRANSFER_ID,
        amount: AMOUNT,
        currency: "usdt",
        state: "failed",
        failureReason: "returned_by_bank",
        createdAt: TRANSFER_CREATED_AT,
      }),
    )
    expect(result[0]).not.toHaveProperty("status")
  })

  it("drops rows without a bridgeTransferId (transferId is NonNull in GraphQL)", async () => {
    ;(BridgeAccountsRepo.findWithdrawalsByAccountId as jest.Mock).mockResolvedValue([
      makePersistedWithdrawal(),
      makePersistedWithdrawal({ bridgeTransferId: null }),
      makePersistedWithdrawal({ bridgeTransferId: undefined }),
    ])

    const result = await BridgeService.getWithdrawals(ACCOUNT_ID)
    if (result instanceof Error) throw result

    // Only the row with a real transferId survives the filter.
    expect(result).toHaveLength(1)
    expect(result[0].transferId).toBe(TRANSFER_ID)
    for (const w of result) {
      expect(w.transferId).toBeTruthy()
    }
  })
})
