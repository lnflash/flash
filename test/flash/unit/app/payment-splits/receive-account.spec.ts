const mockCreateAccount = jest.fn()
const mockCreateLnurlPay = jest.fn()
const mockFindWalletById = jest.fn()
const mockListRules = jest.fn()
const mockShadowInsert = jest.fn()
const mockShadowFindByWalletId = jest.fn()

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    createAccount: (...args: unknown[]) => mockCreateAccount(...args),
    createLnurlPay: (...args: unknown[]) => mockCreateLnurlPay(...args),
  },
}))

jest.mock("@services/mongoose", () => ({
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
}))

jest.mock("@services/mongoose/payment-split-rules", () => ({
  PaymentSplitRulesRepository: jest.fn(() => ({
    listByWalletId: (...args: unknown[]) => mockListRules(...args),
  })),
}))

jest.mock("@services/mongoose/split-receive-accounts", () => ({
  SplitReceiveAccountsRepository: jest.fn(() => ({
    insert: (...args: unknown[]) => mockShadowInsert(...args),
    findByWalletId: (...args: unknown[]) => mockShadowFindByWalletId(...args),
    findByIbexAccountId: jest.fn(async () => null),
    listAll: jest.fn(async () => []),
  })),
}))

import { PaymentSplitsConfig } from "@config"
import {
  ensureReceiveAccount,
  receiveAccountFor,
  resolveShadow,
} from "@app/payment-splits/receive-account"
import { WalletCurrency } from "@domain/shared"

const WALLET = "11111111-1111-4111-8111-111111111111"
const SHADOW_ID = "shadow-ibex-account"

const original = { ...PaymentSplitsConfig }

beforeEach(() => {
  jest.clearAllMocks()
  Object.assign(PaymentSplitsConfig, { enabled: true })
  mockFindWalletById.mockResolvedValue({
    id: WALLET,
    accountId: "owner-account",
    currency: WalletCurrency.Usdt,
  })
  // No enabled rules by default: routing falls back to the real account.
  mockListRules.mockResolvedValue([])
  mockShadowFindByWalletId.mockResolvedValue(null)
  mockShadowInsert.mockImplementation(async () => ({ created: true }))
  mockCreateAccount.mockResolvedValue({ id: SHADOW_ID })
  mockCreateLnurlPay.mockResolvedValue({ lnurl: "lnurl1shadow" })
})

afterAll(() => {
  Object.assign(PaymentSplitsConfig, original)
})

describe("receiveAccountFor", () => {
  it("returns the wallet's own id when it has no rules", async () => {
    expect(await receiveAccountFor(WALLET as WalletId)).toBe(WALLET)
    expect(mockCreateAccount).not.toHaveBeenCalled()
  })

  it("returns the shadow's IBEX account id when an enabled rule exists", async () => {
    mockListRules.mockResolvedValue([
      {
        id: "rule-1",
        walletId: WALLET,
        destinationWalletId: "dest",
        percent: 10,
        enabled: true,
        createdAt: new Date(),
      },
    ])
    mockShadowFindByWalletId.mockResolvedValue({
      walletId: WALLET,
      ibexAccountId: SHADOW_ID,
      currency: "USDT",
      lnurlp: "lnurl1shadow",
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(await receiveAccountFor(WALLET as WalletId)).toBe(SHADOW_ID)
  })

  it("returns the real account when the flag is off, even with rules", async () => {
    PaymentSplitsConfig.enabled = false
    mockListRules.mockResolvedValue([
      {
        id: "rule-1",
        walletId: WALLET,
        destinationWalletId: "dest",
        percent: 10,
        enabled: true,
        createdAt: new Date(),
      },
    ])

    expect(await receiveAccountFor(WALLET as WalletId)).toBe(WALLET)
    expect(mockListRules).not.toHaveBeenCalled()
  })

  it("fails safe to the real account when the wallet lookup or the rules read errors", async () => {
    mockListRules.mockResolvedValue(new Error("mongo down"))
    expect(await receiveAccountFor(WALLET as WalletId)).toBe(WALLET)

    mockFindWalletById.mockResolvedValue(new Error("mongo down"))
    mockListRules.mockResolvedValue([
      {
        id: "rule-1",
        walletId: WALLET,
        destinationWalletId: "dest",
        percent: 10,
        enabled: true,
        createdAt: new Date(),
      },
    ])
    expect(await receiveAccountFor(WALLET as WalletId)).toBe(WALLET)
  })

  it("fails safe to the real account when the shadow read errors or is missing (read-only hot path)", async () => {
    mockListRules.mockResolvedValue([
      {
        id: "rule-1",
        walletId: WALLET,
        destinationWalletId: "dest",
        percent: 10,
        enabled: true,
        createdAt: new Date(),
      },
    ])
    // No shadow row: falls back (creation is walletSplitsSet's job).
    expect(await receiveAccountFor(WALLET as WalletId)).toBe(WALLET)
    expect(mockCreateAccount).not.toHaveBeenCalled()

    // A shadow read error also falls back.
    mockShadowFindByWalletId.mockResolvedValue(new Error("mongo down"))
    expect(await receiveAccountFor(WALLET as WalletId)).toBe(WALLET)
    expect(mockCreateAccount).not.toHaveBeenCalled()
  })
})

describe("ensureReceiveAccount", () => {
  const ensure = () =>
    ensureReceiveAccount({ walletId: WALLET as WalletId, currency: WalletCurrency.Usd })

  it("creates the IBEX account + LNURL and persists it", async () => {
    const record = await ensure()
    if (record instanceof Error) throw record

    expect(mockCreateAccount).toHaveBeenCalledWith(`flash-splits-${WALLET}`, 3)
    expect(mockCreateLnurlPay).toHaveBeenCalledWith({
      accountId: SHADOW_ID,
      currencyId: 3,
    })
    expect(record).toMatchObject({
      walletId: WALLET,
      ibexAccountId: SHADOW_ID,
      currency: WalletCurrency.Usd,
      lnurlp: "lnurl1shadow",
    })
    expect(mockShadowInsert).toHaveBeenCalled()
  })

  it("is idempotent: an existing shadow is returned without IBEX calls", async () => {
    mockShadowFindByWalletId.mockResolvedValue({
      walletId: WALLET,
      ibexAccountId: SHADOW_ID,
      currency: "USDT",
      lnurlp: "lnurl1existing",
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const record = await ensure()
    if (record instanceof Error) throw record

    expect(mockCreateAccount).not.toHaveBeenCalled()
    expect(mockCreateLnurlPay).not.toHaveBeenCalled()
    expect(mockShadowInsert).not.toHaveBeenCalled()
    expect(record.lnurlp).toBe("lnurl1existing")
  })

  it("fails the mutation and persists nothing when the IBEX account creation fails", async () => {
    mockCreateAccount.mockResolvedValue(new Error("ibex 500"))

    const result = await ensure()
    expect(result).toBeInstanceOf(Error)
    expect(mockCreateLnurlPay).not.toHaveBeenCalled()
    expect(mockShadowInsert).not.toHaveBeenCalled()
  })

  it("fails the mutation and persists nothing when the LNURL creation fails", async () => {
    mockCreateLnurlPay.mockResolvedValue(new Error("ibex lnurl 500"))

    const result = await ensure()
    expect(result).toBeInstanceOf(Error)
    // The IBEX account was created (orphaned, harmless) but nothing persisted.
    expect(mockShadowInsert).not.toHaveBeenCalled()
  })

  it("fails the mutation when the persistence fails", async () => {
    mockShadowInsert.mockResolvedValue(new Error("mongo down"))

    expect(await ensure()).toBeInstanceOf(Error)
  })

  it("creates USDT shadows with currencyId 29", async () => {
    const record = await ensureReceiveAccount({
      walletId: WALLET as WalletId,
      currency: WalletCurrency.Usdt,
    })
    if (record instanceof Error) throw record

    expect(mockCreateAccount).toHaveBeenCalledWith(`flash-splits-${WALLET}`, 29)
    expect(mockCreateLnurlPay).toHaveBeenCalledWith({
      accountId: SHADOW_ID,
      currencyId: 29,
    })
  })

  it("resolves a concurrent insert: a duplicate insert reads the winner back", async () => {
    mockShadowInsert.mockResolvedValue({ created: false })
    mockShadowFindByWalletId
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce({
        walletId: WALLET,
        ibexAccountId: "winner-shadow",
        currency: "USDT",
        createdAt: new Date(),
        updatedAt: new Date(),
      }) // read-back

    const record = await ensure()
    if (record instanceof Error) throw record
    expect(record.ibexAccountId).toBe("winner-shadow")
  })
})

describe("resolveShadow", () => {
  it("is a passthrough to the repo's findByIbexAccountId", async () => {
    // The repo mock above wires findByIbexAccountId to return null.
    expect(await resolveShadow(SHADOW_ID)).toBeNull()
  })
})
