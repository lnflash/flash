const mockFindWalletById = jest.fn()
const mockReplaceForWallet = jest.fn()
const mockFindRuleById = jest.fn()
const mockDeleteRuleById = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({ findByUsername: jest.fn() })),
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
    listByAccountId: jest.fn(),
  })),
}))

jest.mock("@services/mongoose/payment-split-rules", () => ({
  PaymentSplitRulesRepository: jest.fn(() => ({
    replaceForWallet: (...args: unknown[]) => mockReplaceForWallet(...args),
    findById: (...args: unknown[]) => mockFindRuleById(...args),
    deleteById: (...args: unknown[]) => mockDeleteRuleById(...args),
  })),
}))

jest.mock("@services/lock", () => ({
  LockService: jest.fn(() => ({
    lockWalletId: async (_id: string, fn: () => Promise<unknown>) => fn(),
  })),
}))

jest.mock("@services/logger", () => ({
  baseLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  },
}))

import { PaymentSplitsConfig } from "@config"
import { CouldNotFindWalletFromIdError } from "@domain/errors"
import { WalletCurrency } from "@domain/shared"
import WalletSplitDeleteMutation from "@graphql/public/root/mutation/wallet-split-delete"
import WalletSplitsSetMutation from "@graphql/public/root/mutation/wallet-splits-set"

const OWNER_ID = "owner-account"
const SOURCE_ID = "11111111-1111-4111-8111-111111111111"
const DEST_ID = "22222222-2222-4222-8222-222222222222"
const FOREIGN_ID = "33333333-3333-4333-8333-333333333333"

const walletsById: Record<string, unknown> = {
  [SOURCE_ID]: { id: SOURCE_ID, accountId: OWNER_ID, currency: WalletCurrency.Usdt },
  [DEST_ID]: { id: DEST_ID, accountId: "dest-account", currency: WalletCurrency.Usdt },
  [FOREIGN_ID]: {
    id: FOREIGN_ID,
    accountId: "someone-else",
    currency: WalletCurrency.Usdt,
  },
}

type Result = {
  errors: Array<{ message: string; code?: string }>
  splits?: unknown[]
  success?: boolean
}

const ctx = { domainAccount: { id: OWNER_ID } } as unknown as GraphQLPublicContextAuth

const resolveSet = (input: Record<string, unknown>) =>
  (
    WalletSplitsSetMutation as unknown as {
      resolve: (s: null, a: unknown, c: unknown, i: never) => Promise<Result>
    }
  ).resolve(null, { input }, ctx, {} as never)

const resolveDelete = (input: Record<string, unknown>) =>
  (
    WalletSplitDeleteMutation as unknown as {
      resolve: (s: null, a: unknown, c: unknown, i: never) => Promise<Result>
    }
  ).resolve(null, { input }, ctx, {} as never)

const originalEnabled = PaymentSplitsConfig.enabled

beforeEach(() => {
  jest.clearAllMocks()
  PaymentSplitsConfig.enabled = true
  mockFindWalletById.mockImplementation(
    async (id: string) => walletsById[id] ?? new CouldNotFindWalletFromIdError(),
  )
  mockReplaceForWallet.mockImplementation(
    async (walletId: string, rules: { destinationWalletId: string; percent: number }[]) =>
      rules.map((r, i) => ({
        id: `rule-${i}`,
        walletId,
        enabled: true,
        createdAt: new Date(),
        ...r,
      })),
  )
})

afterAll(() => {
  PaymentSplitsConfig.enabled = originalEnabled
})

describe("walletSplitsSet", () => {
  it("returns the new split set", async () => {
    const result = await resolveSet({
      walletId: SOURCE_ID,
      splits: [{ destination: DEST_ID, percent: 30 }],
    })

    expect(result.errors).toEqual([])
    expect(result.splits).toEqual([
      expect.objectContaining({ destinationWalletId: DEST_ID, percent: 30 }),
    ])
  })

  it("rejects another account's walletId", async () => {
    const result = await resolveSet({
      walletId: FOREIGN_ID,
      splits: [{ destination: DEST_ID, percent: 30 }],
    })

    expect(result.splits).toBeUndefined()
    expect(result.errors).toHaveLength(1)
    expect(mockReplaceForWallet).not.toHaveBeenCalled()
  })

  it("maps an over-100% set to a user-readable validation error", async () => {
    walletsById[FOREIGN_ID] = {
      id: FOREIGN_ID,
      accountId: "someone-else",
      currency: WalletCurrency.Usdt,
    }
    const result = await resolveSet({
      walletId: SOURCE_ID,
      splits: [
        { destination: DEST_ID, percent: 70 },
        { destination: FOREIGN_ID, percent: 31 },
      ],
    })

    expect(result.errors).toEqual([
      expect.objectContaining({
        message: "Split percentages must add up to more than 0 and at most 100",
      }),
    ])
  })

  it("maps a self split", async () => {
    const result = await resolveSet({
      walletId: SOURCE_ID,
      splits: [{ destination: SOURCE_ID, percent: 10 }],
    })

    expect(result.errors[0].message).toBe("A wallet cannot split payments to itself")
  })

  it("maps an unknown destination", async () => {
    const result = await resolveSet({
      walletId: SOURCE_ID,
      splits: [{ destination: "44444444-4444-4444-8444-444444444444", percent: 10 }],
    })

    expect(result.errors[0].message).toMatch(/^No wallet found for/)
  })

  it("maps the disabled flag", async () => {
    PaymentSplitsConfig.enabled = false

    const result = await resolveSet({
      walletId: SOURCE_ID,
      splits: [{ destination: DEST_ID, percent: 10 }],
    })

    expect(result.errors[0].message).toBe("Payment splits are not available")
  })

  it("passes an input validation error through", async () => {
    const result = await resolveSet({
      walletId: new Error("Invalid value for WalletId"),
      splits: [],
    })

    expect(result.errors[0].message).toBe("Invalid value for WalletId")
  })
})

describe("walletSplitDelete", () => {
  it("deletes the caller's split", async () => {
    mockFindRuleById.mockResolvedValue({ id: "rule-1", walletId: SOURCE_ID })
    mockDeleteRuleById.mockResolvedValue(true)

    expect(await resolveDelete({ walletId: SOURCE_ID, splitId: "rule-1" })).toEqual({
      errors: [],
      success: true,
    })
  })

  it("maps a split on another wallet to not-found", async () => {
    mockFindRuleById.mockResolvedValue({ id: "rule-1", walletId: DEST_ID })

    const result = await resolveDelete({ walletId: SOURCE_ID, splitId: "rule-1" })

    expect(result.success).toBe(false)
    expect(result.errors[0].message).toBe("Payment split not found")
    expect(mockDeleteRuleById).not.toHaveBeenCalled()
  })

  it("rejects another account's walletId", async () => {
    const result = await resolveDelete({ walletId: FOREIGN_ID, splitId: "rule-1" })

    expect(result.success).toBe(false)
    expect(mockFindRuleById).not.toHaveBeenCalled()
  })
})
