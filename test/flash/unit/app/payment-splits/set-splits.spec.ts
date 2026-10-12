const mockFindWalletById = jest.fn()
const mockListByAccountId = jest.fn()
const mockFindByUsername = jest.fn()
const mockReplaceForWallet = jest.fn()
const mockFindRuleById = jest.fn()
const mockDeleteRuleById = jest.fn()
const mockLockWalletId = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({
    findByUsername: (...args: unknown[]) => mockFindByUsername(...args),
  })),
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
    listByAccountId: (...args: unknown[]) => mockListByAccountId(...args),
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
    lockWalletId: (...args: unknown[]) => mockLockWalletId(...args),
  })),
}))

import { PaymentSplitsConfig } from "@config"
import { deletePaymentSplit } from "@app/payment-splits/delete-split"
import { setPaymentSplits } from "@app/payment-splits/set-splits"
import { InvalidWalletForAccountError } from "@domain/accounts/errors"
import {
  CouldNotFindAccountFromUsernameError,
  CouldNotFindWalletFromIdError,
} from "@domain/errors"
import {
  PaymentSplitsDisabledError,
  SplitCurrencyMismatchError,
  SplitDestinationNotFoundError,
  SplitPercentExceededError,
  SplitRuleNotFoundError,
} from "@domain/payment-splits"
import { WalletCurrency } from "@domain/shared"

const OWNER = { id: "owner-account" } as Account
const SOURCE_ID = "11111111-1111-4111-8111-111111111111"
const DEST_ID = "22222222-2222-4222-8222-222222222222"
const OTHER_ID = "33333333-3333-4333-8333-333333333333"
const ALICE_USD = "44444444-4444-4444-8444-444444444444"
const ALICE_USDT = "55555555-5555-4555-8555-555555555555"
const ALICE_BTC = "66666666-6666-4666-8666-666666666666"

const wallets: Record<string, Wallet> = {
  [SOURCE_ID]: { id: SOURCE_ID, accountId: OWNER.id, currency: WalletCurrency.Usdt },
  [DEST_ID]: { id: DEST_ID, accountId: "dest-account", currency: WalletCurrency.Usdt },
  [OTHER_ID]: { id: OTHER_ID, accountId: "other-account", currency: WalletCurrency.Usdt },
} as unknown as Record<string, Wallet>

const aliceWallets = [
  // Alice's DEFAULT wallet is BTC; a username must not resolve to it blindly.
  { id: ALICE_BTC, accountId: "alice", currency: WalletCurrency.Btc },
  { id: ALICE_USD, accountId: "alice", currency: WalletCurrency.Usd },
  { id: ALICE_USDT, accountId: "alice", currency: WalletCurrency.Usdt },
]

const originalEnabled = PaymentSplitsConfig.enabled

beforeEach(() => {
  jest.clearAllMocks()
  PaymentSplitsConfig.enabled = true
  mockFindWalletById.mockImplementation(
    async (id: string) => wallets[id] ?? new CouldNotFindWalletFromIdError(),
  )
  mockFindByUsername.mockImplementation(async (username: string) =>
    username.toLowerCase() === "alice"
      ? { id: "alice", defaultWalletId: ALICE_BTC }
      : new CouldNotFindAccountFromUsernameError(username),
  )
  mockListByAccountId.mockResolvedValue(aliceWallets)
  mockLockWalletId.mockImplementation(async (_id: string, fn: () => Promise<unknown>) =>
    fn(),
  )
  mockReplaceForWallet.mockImplementation(
    async (walletId: string, rules: { destinationWalletId: string; percent: number }[]) =>
      rules.map((rule, i) => ({ id: `rule-${i}`, walletId, enabled: true, ...rule })),
  )
})

afterAll(() => {
  PaymentSplitsConfig.enabled = originalEnabled
})

describe("setPaymentSplits", () => {
  it("resolves a walletId destination and replaces the set under the wallet lock", async () => {
    const result = await setPaymentSplits({
      account: OWNER,
      walletId: SOURCE_ID,
      splits: [{ destination: DEST_ID, percent: 25 }],
    })

    expect(result).toEqual([
      expect.objectContaining({ destinationWalletId: DEST_ID, percent: 25 }),
    ])
    expect(mockLockWalletId).toHaveBeenCalledWith(SOURCE_ID, expect.any(Function))
    expect(mockReplaceForWallet).toHaveBeenCalledWith(SOURCE_ID, [
      { destinationWalletId: DEST_ID, percent: 25 },
    ])
  })

  it("only writes while the lock is held", async () => {
    let lockHeld = false
    mockLockWalletId.mockImplementation(
      async (_id: string, fn: () => Promise<unknown>) => {
        lockHeld = true
        try {
          return await fn()
        } finally {
          lockHeld = false
        }
      },
    )
    mockReplaceForWallet.mockImplementation(async () => {
      expect(lockHeld).toBe(true)
      return []
    })

    await setPaymentSplits({
      account: OWNER,
      walletId: SOURCE_ID,
      splits: [{ destination: DEST_ID, percent: 25 }],
    })
    expect(mockReplaceForWallet).toHaveBeenCalledTimes(1)
  })

  it("resolves a username to that account's wallet in the SOURCE currency, not its default", async () => {
    await setPaymentSplits({
      account: OWNER,
      walletId: SOURCE_ID,
      splits: [{ destination: "@Alice", percent: 10 }],
    })

    expect(mockListByAccountId).toHaveBeenCalledWith("alice")
    expect(mockReplaceForWallet).toHaveBeenCalledWith(SOURCE_ID, [
      { destinationWalletId: ALICE_USDT, percent: 10 },
    ])
  })

  it("rejects a username with no wallet in the source currency", async () => {
    mockListByAccountId.mockResolvedValue([aliceWallets[0]])

    const result = await setPaymentSplits({
      account: OWNER,
      walletId: SOURCE_ID,
      splits: [{ destination: "alice", percent: 10 }],
    })

    expect(result).toBeInstanceOf(SplitDestinationNotFoundError)
    expect(mockReplaceForWallet).not.toHaveBeenCalled()
  })

  it("rejects an unknown username or walletId", async () => {
    expect(
      await setPaymentSplits({
        account: OWNER,
        walletId: SOURCE_ID,
        splits: [{ destination: "nobody", percent: 10 }],
      }),
    ).toBeInstanceOf(SplitDestinationNotFoundError)
    expect(
      await setPaymentSplits({
        account: OWNER,
        walletId: SOURCE_ID,
        splits: [{ destination: "77777777-7777-4777-8777-777777777777", percent: 10 }],
      }),
    ).toBeInstanceOf(SplitDestinationNotFoundError)
  })

  it("rejects a walletId destination in another currency", async () => {
    const result = await setPaymentSplits({
      account: OWNER,
      walletId: SOURCE_ID,
      splits: [{ destination: ALICE_USD, percent: 10 }],
    })
    // ALICE_USD is not in the walletId fixture map; give it one.
    expect(result).toBeInstanceOf(SplitDestinationNotFoundError)

    wallets[ALICE_USD] = aliceWallets[1] as unknown as Wallet
    expect(
      await setPaymentSplits({
        account: OWNER,
        walletId: SOURCE_ID,
        splits: [{ destination: ALICE_USD, percent: 10 }],
      }),
    ).toBeInstanceOf(SplitCurrencyMismatchError)
    delete wallets[ALICE_USD]
  })

  it("re-checks that the source wallet belongs to the caller", async () => {
    const result = await setPaymentSplits({
      account: OWNER,
      walletId: OTHER_ID,
      splits: [{ destination: DEST_ID, percent: 10 }],
    })

    expect(result).toBeInstanceOf(InvalidWalletForAccountError)
    expect(mockLockWalletId).not.toHaveBeenCalled()
    expect(mockReplaceForWallet).not.toHaveBeenCalled()
  })

  it("rejects a set over 100% without writing", async () => {
    mockFindWalletById.mockImplementation(async (id: string) =>
      id === SOURCE_ID
        ? wallets[SOURCE_ID]
        : { id, accountId: "x", currency: WalletCurrency.Usdt },
    )
    const result = await setPaymentSplits({
      account: OWNER,
      walletId: SOURCE_ID,
      splits: [
        { destination: DEST_ID, percent: 60 },
        { destination: OTHER_ID, percent: 41 },
      ],
    })

    expect(result).toBeInstanceOf(SplitPercentExceededError)
    expect(mockReplaceForWallet).not.toHaveBeenCalled()
  })

  it("rejects everything while the feature flag is off", async () => {
    PaymentSplitsConfig.enabled = false
    const result = await setPaymentSplits({
      account: OWNER,
      walletId: SOURCE_ID,
      splits: [{ destination: DEST_ID, percent: 25 }],
    })
    expect(result).toBeInstanceOf(PaymentSplitsDisabledError)
    expect(mockFindWalletById).not.toHaveBeenCalled()
  })
})

describe("deletePaymentSplit", () => {
  it("deletes a rule on the caller's wallet", async () => {
    mockFindRuleById.mockResolvedValue({ id: "rule-1", walletId: SOURCE_ID })
    mockDeleteRuleById.mockResolvedValue(true)

    const result = await deletePaymentSplit({
      account: OWNER,
      walletId: SOURCE_ID,
      splitId: "rule-1",
    })

    expect(result).toBe(true)
    expect(mockDeleteRuleById).toHaveBeenCalledWith("rule-1")
    expect(mockLockWalletId).toHaveBeenCalledWith(SOURCE_ID, expect.any(Function))
  })

  it("refuses a rule that belongs to another wallet", async () => {
    mockFindRuleById.mockResolvedValue({ id: "rule-1", walletId: OTHER_ID })

    const result = await deletePaymentSplit({
      account: OWNER,
      walletId: SOURCE_ID,
      splitId: "rule-1",
    })

    expect(result).toBeInstanceOf(SplitRuleNotFoundError)
    expect(mockDeleteRuleById).not.toHaveBeenCalled()
  })

  it("reports a missing rule", async () => {
    mockFindRuleById.mockResolvedValue(null)
    expect(
      await deletePaymentSplit({ account: OWNER, walletId: SOURCE_ID, splitId: "nope" }),
    ).toBeInstanceOf(SplitRuleNotFoundError)
  })

  it("re-checks wallet ownership", async () => {
    expect(
      await deletePaymentSplit({ account: OWNER, walletId: OTHER_ID, splitId: "rule-1" }),
    ).toBeInstanceOf(InvalidWalletForAccountError)
    expect(mockFindRuleById).not.toHaveBeenCalled()
  })
})
