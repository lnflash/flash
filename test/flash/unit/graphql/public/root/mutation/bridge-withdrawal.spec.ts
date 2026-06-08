// jest.mock calls are hoisted before imports

jest.mock("@services/bridge", () => ({
  __esModule: true,
  default: {
    requestWithdrawal: jest.fn(),
    initiateWithdrawal: jest.fn(),
    cancelWithdrawalRequest: jest.fn(),
  },
}))

jest.mock("@config", () => ({
  BridgeConfig: { enabled: true, minWithdrawalAmount: 10 },
  getOnChainWalletConfig: jest.fn().mockReturnValue({ dustThreshold: 546 }),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import BridgeService from "@services/bridge"
import BridgeRequestWithdrawalMutation from "@graphql/public/root/mutation/bridge-request-withdrawal"
import BridgeInitiateWithdrawalMutation from "@graphql/public/root/mutation/bridge-initiate-withdrawal"
import BridgeCancelWithdrawalRequestMutation from "@graphql/public/root/mutation/bridge-cancel-withdrawal-request"
import {
  BridgeWithdrawalNotFoundError,
  BridgeWithdrawalAlreadyInitiatedError,
} from "@services/bridge/errors"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = "account-001" as AccountId
const EXTERNAL_ACCOUNT_ID = "ext-001"
const AMOUNT = "50"
const WITHDRAWAL_ID = "withdrawal-001"
const TRANSFER_ID = "transfer-001"
const CREATED_AT = new Date("2026-01-01T00:00:00Z")

const ctx = {
  domainAccount: { id: ACCOUNT_ID, level: 2 },
} as unknown as GraphQLPublicContextAuth

const makePendingRow = (overrides: Record<string, unknown> = {}) => ({
  id: WITHDRAWAL_ID,
  accountId: ACCOUNT_ID as string,
  amount: AMOUNT,
  currency: "usdt",
  externalAccountId: EXTERNAL_ACCOUNT_ID,
  status: "pending" as const,
  createdAt: CREATED_AT,
  ...overrides,
})

// ── bridgeRequestWithdrawal ───────────────────────────────────────────────────

describe("bridgeRequestWithdrawal resolver", () => {
  beforeEach(() => jest.clearAllMocks())

  it("creates a pending withdrawal and returns it", async () => {
    const pendingRow = makePendingRow()
    ;(BridgeService.requestWithdrawal as jest.Mock).mockResolvedValue(pendingRow)

    const result = await BridgeRequestWithdrawalMutation.resolve?.(
      null,
      { input: { amount: AMOUNT, externalAccountId: EXTERNAL_ACCOUNT_ID } },
      ctx,
      {} as never,
    )

    expect(BridgeService.requestWithdrawal).toHaveBeenCalledWith(
      ACCOUNT_ID,
      AMOUNT,
      EXTERNAL_ACCOUNT_ID,
    )
    expect(result?.errors).toEqual([])
    expect(result?.withdrawal).toEqual(pendingRow)
    expect(result?.withdrawal?.status).toBe("pending")
    expect(result?.withdrawal?.externalAccountId).toBe(EXTERNAL_ACCOUNT_ID)
  })

  it("returns an existing pending row when the service deduplicates the request", async () => {
    const existingRow = makePendingRow({ id: "existing-withdrawal-001" })
    ;(BridgeService.requestWithdrawal as jest.Mock).mockResolvedValue(existingRow)

    const result = await BridgeRequestWithdrawalMutation.resolve?.(
      null,
      { input: { amount: AMOUNT, externalAccountId: EXTERNAL_ACCOUNT_ID } },
      ctx,
      {} as never,
    )

    expect(result?.errors).toEqual([])
    expect(result?.withdrawal?.id).toBe("existing-withdrawal-001")
    expect(result?.withdrawal?.status).toBe("pending")
  })
})

// ── bridgeInitiateWithdrawal ──────────────────────────────────────────────────

describe("bridgeInitiateWithdrawal resolver", () => {
  beforeEach(() => jest.clearAllMocks())

  it("submits the pending row and returns the withdrawal with bridgeTransferId recorded", async () => {
    const initiatedRow = makePendingRow({ bridgeTransferId: TRANSFER_ID, status: "submitted" })
    ;(BridgeService.initiateWithdrawal as jest.Mock).mockResolvedValue(initiatedRow)

    const result = await BridgeInitiateWithdrawalMutation.resolve?.(
      null,
      { input: { withdrawalId: WITHDRAWAL_ID } },
      ctx,
      {} as never,
    )

    expect(BridgeService.initiateWithdrawal).toHaveBeenCalledWith(ACCOUNT_ID, WITHDRAWAL_ID)
    expect(result?.errors).toEqual([])
    expect(result?.withdrawal?.status).toBe("submitted")
    expect(result?.withdrawal?.bridgeTransferId).toBe(TRANSFER_ID)
  })

  it("maps BridgeWithdrawalNotFoundError to BRIDGE_WITHDRAWAL_NOT_FOUND when ID is missing or wrong-owner", async () => {
    ;(BridgeService.initiateWithdrawal as jest.Mock).mockResolvedValue(
      new BridgeWithdrawalNotFoundError(),
    )

    const result = await BridgeInitiateWithdrawalMutation.resolve?.(
      null,
      { input: { withdrawalId: WITHDRAWAL_ID } },
      ctx,
      {} as never,
    )

    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0].code).toBe("BRIDGE_WITHDRAWAL_NOT_FOUND")
    expect(result?.withdrawal).toBeUndefined()
  })

  it("maps BridgeWithdrawalAlreadyInitiatedError to BRIDGE_WITHDRAWAL_ALREADY_INITIATED", async () => {
    ;(BridgeService.initiateWithdrawal as jest.Mock).mockResolvedValue(
      new BridgeWithdrawalAlreadyInitiatedError(),
    )

    const result = await BridgeInitiateWithdrawalMutation.resolve?.(
      null,
      { input: { withdrawalId: WITHDRAWAL_ID } },
      ctx,
      {} as never,
    )

    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0].code).toBe("BRIDGE_WITHDRAWAL_ALREADY_INITIATED")
    expect(result?.withdrawal).toBeUndefined()
  })
})

// ── bridgeCancelWithdrawalRequest ─────────────────────────────────────────────

describe("bridgeCancelWithdrawalRequest resolver", () => {
  beforeEach(() => jest.clearAllMocks())

  it("delegates to cancelWithdrawalRequest and returns the cancelled withdrawal", async () => {
    const cancelledRow = makePendingRow({ status: "cancelled" })
    ;(BridgeService.cancelWithdrawalRequest as jest.Mock).mockResolvedValue(cancelledRow)

    const result = await BridgeCancelWithdrawalRequestMutation.resolve?.(
      null,
      { input: { withdrawalId: WITHDRAWAL_ID } },
      ctx,
      {} as never,
    )

    expect(BridgeService.cancelWithdrawalRequest).toHaveBeenCalledWith(
      ACCOUNT_ID,
      WITHDRAWAL_ID,
    )
    expect(result?.errors).toEqual([])
    expect(result?.withdrawal?.status).toBe("cancelled")
    expect(result?.withdrawal?.id).toBe(WITHDRAWAL_ID)
    expect(result?.withdrawal?.amount).toBe(AMOUNT)
  })

  it("maps BridgeWithdrawalNotFoundError to BRIDGE_WITHDRAWAL_NOT_FOUND when ID is missing or wrong-owner", async () => {
    ;(BridgeService.cancelWithdrawalRequest as jest.Mock).mockResolvedValue(
      new BridgeWithdrawalNotFoundError(),
    )

    const result = await BridgeCancelWithdrawalRequestMutation.resolve?.(
      null,
      { input: { withdrawalId: WITHDRAWAL_ID } },
      ctx,
      {} as never,
    )

    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0].code).toBe("BRIDGE_WITHDRAWAL_NOT_FOUND")
    expect(result?.withdrawal).toBeUndefined()
  })

  it("maps BridgeWithdrawalAlreadyInitiatedError to BRIDGE_WITHDRAWAL_ALREADY_INITIATED when already submitted", async () => {
    ;(BridgeService.cancelWithdrawalRequest as jest.Mock).mockResolvedValue(
      new BridgeWithdrawalAlreadyInitiatedError(),
    )

    const result = await BridgeCancelWithdrawalRequestMutation.resolve?.(
      null,
      { input: { withdrawalId: WITHDRAWAL_ID } },
      ctx,
      {} as never,
    )

    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0].code).toBe("BRIDGE_WITHDRAWAL_ALREADY_INITIATED")
    expect(result?.withdrawal).toBeUndefined()
  })
})
