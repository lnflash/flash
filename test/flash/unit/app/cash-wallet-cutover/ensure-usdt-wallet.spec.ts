// jest.mock calls are hoisted before imports

const mockLockAccountId = jest.fn()
const mockListByAccountId = jest.fn()
const mockPersistNew = jest.fn()

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
jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { WalletCurrency } from "@domain/shared"
import { ensureUsdtWalletForAccount } from "@app/cash-wallet-cutover/ensure-usdt-wallet"

const ACCOUNT = { id: "account-1" } as unknown as Account
const usdtWallet = (id: string) =>
  ({ id, currency: WalletCurrency.Usdt }) as unknown as Wallet
const btcWallet = { id: "btc-1", currency: WalletCurrency.Btc } as unknown as Wallet

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
    expect(mockPersistNew).toHaveBeenCalledWith({
      accountId: "account-1",
      type: expect.anything(),
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
})
