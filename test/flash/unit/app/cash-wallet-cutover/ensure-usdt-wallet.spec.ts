// jest.mock calls are hoisted before imports

const mockLockAccountId = jest.fn()
const mockListByAccountId = jest.fn()
const mockPersistNew = jest.fn()
const mockUpdateDefaultWalletId = jest.fn()

jest.mock("@services/lock", () => ({
  LockService: () => ({
    lockAccountId: (...args: unknown[]) => mockLockAccountId(...args),
  }),
}))
jest.mock("@services/mongoose", () => ({
  WalletsRepository: () => ({
    listByAccountId: (...args: unknown[]) => mockListByAccountId(...args),
    persistNew: (...args: unknown[]) => mockPersistNew(...args),
  }),
}))
jest.mock("@app/accounts/update-default-walletid", () => ({
  updateDefaultWalletId: (...args: unknown[]) => mockUpdateDefaultWalletId(...args),
}))
jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { WalletType } from "@domain/wallets"
import { WalletCurrency } from "@domain/shared"
import { ensureUsdtWalletForAccount } from "@app/cash-wallet-cutover/ensure-usdt-wallet"

const account = (defaultWalletId?: string) =>
  ({ id: "account-1", defaultWalletId }) as unknown as Account
const ACCOUNT = account()
const usdtWallet = (id: string) =>
  ({ id, currency: WalletCurrency.Usdt }) as unknown as Wallet
const btcWallet = { id: "btc-1", currency: WalletCurrency.Btc } as unknown as Wallet
const usdWallet = { id: "usd-1", currency: WalletCurrency.Usd } as unknown as Wallet

// The lock passes its callback through — each test controls what the
// re-listed world looks like INSIDE the lock.
const lockPassesThrough = () =>
  mockLockAccountId.mockImplementation(async (_id: string, fn: () => Promise<unknown>) =>
    fn(),
  )

beforeEach(() => {
  jest.clearAllMocks()
  lockPassesThrough()
})

describe("ensureUsdtWalletForAccount", () => {
  it("creates the wallet under the account lock when it is genuinely missing", async () => {
    mockListByAccountId.mockResolvedValue([btcWallet])
    mockPersistNew.mockResolvedValue(usdtWallet("usdt-new"))

    const result = await ensureUsdtWalletForAccount({ account: ACCOUNT })

    expect(result).toEqual(usdtWallet("usdt-new"))
    expect(mockLockAccountId).toHaveBeenCalledWith("account-1", expect.any(Function))
    // Exactly what account creation mints (create-account.ts) — a silent
    // type drift here would diverge healed wallets from created ones.
    expect(mockPersistNew).toHaveBeenCalledWith({
      accountId: "account-1",
      type: WalletType.Checking,
      currency: WalletCurrency.Usdt,
    })
  })

  it("returns the winner's wallet when a concurrent resolution got there first", async () => {
    // THE RACE this function exists to close. This runs on an unauthenticated
    // path (lightning-address resolution), and persistNew is NOT idempotent —
    // every call mints a fresh IBEX account. The loser of the race must find
    // the winner's wallet on the re-list inside the lock and create nothing.
    mockListByAccountId.mockResolvedValue([btcWallet, usdtWallet("usdt-winner")])

    const result = await ensureUsdtWalletForAccount({ account: ACCOUNT })

    expect(result).toEqual(usdtWallet("usdt-winner"))
    expect(mockPersistNew).not.toHaveBeenCalled()
  })

  it("degrades to null when creation fails — never worse than the status quo", async () => {
    mockListByAccountId.mockResolvedValue([btcWallet])
    mockPersistNew.mockResolvedValue(new Error("ibex is down"))

    await expect(ensureUsdtWalletForAccount({ account: ACCOUNT })).resolves.toBeNull()
  })

  it("treats a lock failure as creation failure, not as permission to create unlocked", async () => {
    // Unlocked creation is exactly the double-mint the lock prevents. A Redis
    // blip means "try again next resolution", never "wing it".
    mockLockAccountId.mockResolvedValue(new Error("redlock unavailable"))

    await expect(ensureUsdtWalletForAccount({ account: ACCOUNT })).resolves.toBeNull()
    expect(mockPersistNew).not.toHaveBeenCalled()
    expect(mockListByAccountId).not.toHaveBeenCalled()
  })

  it("returns null when the re-list inside the lock fails", async () => {
    // Creating against an unreadable wallet list would be creating blind — the
    // list is what proves the wallet is missing.
    mockListByAccountId.mockResolvedValue(new Error("mongo down"))

    await expect(ensureUsdtWalletForAccount({ account: ACCOUNT })).resolves.toBeNull()
    expect(mockPersistNew).not.toHaveBeenCalled()
  })

  describe("default-wallet pointer convergence", () => {
    // The real migration pairs wallet creation with a pointer flip
    // (runtime-services: addWalletIfNonexistent + updateDefaultWalletId).
    // The heal must converge the same way, or the account keeps the retired
    // USD wallet as its stored default: balance notifications keep landing on
    // it, the operator dashboard shows the wrong default, and discovery
    // re-flags the account as "legacy_default".

    it("flips the stored default off the retired legacy USD wallet onto the created wallet", async () => {
      mockListByAccountId.mockResolvedValue([btcWallet, usdWallet])
      mockPersistNew.mockResolvedValue(usdtWallet("usdt-new"))

      const result = await ensureUsdtWalletForAccount({ account: account("usd-1") })

      expect(result).toEqual(usdtWallet("usdt-new"))
      expect(mockUpdateDefaultWalletId).toHaveBeenCalledWith({
        accountId: "account-1",
        walletId: "usdt-new",
      })
    })

    it("converges the pointer even when the race loser finds the winner's wallet", async () => {
      mockListByAccountId.mockResolvedValue([
        btcWallet,
        usdWallet,
        usdtWallet("usdt-winner"),
      ])

      const result = await ensureUsdtWalletForAccount({ account: account("usd-1") })

      expect(result).toEqual(usdtWallet("usdt-winner"))
      expect(mockPersistNew).not.toHaveBeenCalled()
      expect(mockUpdateDefaultWalletId).toHaveBeenCalledWith({
        accountId: "account-1",
        walletId: "usdt-winner",
      })
    })

    it("leaves a deliberate non-cash default alone", async () => {
      // A BTC default is the user's choice, not cutover residue — flipping it
      // would be the heal overreaching.
      mockListByAccountId.mockResolvedValue([btcWallet, usdWallet])
      mockPersistNew.mockResolvedValue(usdtWallet("usdt-new"))

      const result = await ensureUsdtWalletForAccount({ account: account("btc-1") })

      expect(result).toEqual(usdtWallet("usdt-new"))
      expect(mockUpdateDefaultWalletId).not.toHaveBeenCalled()
    })

    it("a failed pointer flip does not undo the heal", async () => {
      // The wallet exists and resolution can proceed against it; the residual
      // pointer is exactly what discovery flags for the operator flow.
      mockListByAccountId.mockResolvedValue([btcWallet, usdWallet])
      mockPersistNew.mockResolvedValue(usdtWallet("usdt-new"))
      mockUpdateDefaultWalletId.mockResolvedValue(new Error("mongo write failed"))

      const result = await ensureUsdtWalletForAccount({ account: account("usd-1") })

      expect(result).toEqual(usdtWallet("usdt-new"))
    })
  })

  describe("injected repo routing", () => {
    it("routes the re-list and the create through an injected repo with persistNew", async () => {
      const injectedList = jest.fn().mockResolvedValue([btcWallet])
      const injectedPersist = jest.fn().mockResolvedValue(usdtWallet("usdt-injected"))

      const result = await ensureUsdtWalletForAccount({
        account: ACCOUNT,
        walletsRepo: { listByAccountId: injectedList, persistNew: injectedPersist },
      })

      expect(result).toEqual(usdtWallet("usdt-injected"))
      expect(injectedList).toHaveBeenCalledWith("account-1")
      expect(injectedPersist).toHaveBeenCalledWith({
        accountId: "account-1",
        type: WalletType.Checking,
        currency: WalletCurrency.Usdt,
      })
      // Nothing leaks to the real repo when the injected one covers both.
      expect(mockListByAccountId).not.toHaveBeenCalled()
      expect(mockPersistNew).not.toHaveBeenCalled()
    })

    it("falls back to the real repo's persistNew for a list-only injected repo", async () => {
      const injectedList = jest.fn().mockResolvedValue([btcWallet])
      mockPersistNew.mockResolvedValue(usdtWallet("usdt-new"))

      const result = await ensureUsdtWalletForAccount({
        account: ACCOUNT,
        walletsRepo: { listByAccountId: injectedList },
      })

      expect(result).toEqual(usdtWallet("usdt-new"))
      expect(injectedList).toHaveBeenCalledWith("account-1")
      expect(mockPersistNew).toHaveBeenCalled()
    })
  })
})
