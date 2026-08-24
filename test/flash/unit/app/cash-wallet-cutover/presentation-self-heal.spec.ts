// jest.mock calls are hoisted before imports

const mockEnsureUsdtWallet = jest.fn()

jest.mock("@app/cash-wallet-cutover/ensure-usdt-wallet", () => ({
  ensureUsdtWalletForAccount: (...args: unknown[]) => mockEnsureUsdtWallet(...args),
}))
// The resolver imports the real repos as defaults; both are injected per test.
// The resolver's DEFAULT balance reader lazy-imports the real IBEX-backed
// module at call time; unmocked, any test that exercises the gate without
// injecting a reader opens a live Redis/IBEX connection and hangs the runner.
jest.mock("@app/wallets/get-balance-for-wallet", () => ({
  getBalanceForWallet: async () => ({ isZero: () => true }),
}))
jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))
jest.mock("@services/mongoose", () => ({
  WalletsRepository: () => ({}),
  CashWalletCutoverRepository: () => ({}),
}))

import { USDAmount, WalletCurrency } from "@domain/shared"
import { resolveCashWalletPresentationForAccount } from "@app/cash-wallet-cutover/presentation-for-account"
import { CashWalletMissingUsdtWalletError } from "@app/cash-wallet-cutover/errors"
import type { CashWalletClientCapabilities } from "@app/cash-wallet-cutover/client-capability"

const ACCOUNT = { id: "account-1" } as unknown as Account
const btcWallet = { id: "btc-1", currency: WalletCurrency.Btc } as unknown as Wallet
const usdWallet = { id: "usd-1", currency: WalletCurrency.Usd } as unknown as Wallet
const usdtWallet = { id: "usdt-1", currency: WalletCurrency.Usdt } as unknown as Wallet

// A completed cutover: every account resolves to the "usdt" presentation —
// the exact state in which ENG-544 bit, because it makes the USDT wallet
// load-bearing for lightning-address resolution.
const migrationsRepo = {
  getConfig: async () =>
    ({ state: "complete", cutoverVersion: 1, runId: "run-1" }) as CashWalletCutoverConfig,
  findMigrationByAccountId: async () => null,
}

const walletsRepoWith = (wallets: Wallet[]) => ({
  listByAccountId: async () => wallets,
})

// A modern client (v0.6.x sends the usdt capability header). With the field
// wrongly shaped this silently decides "legacy_usd_compat" instead of "usdt" —
// which ALSO errors on a missing USDT wallet, so the self-heal covers both;
// the fixtures pin the real shape so the assertions name the right wallet.
// The gate consults the legacy balance before healing under "usdt". Default
// fixture: a drained legacy wallet (the fleet this heal exists for).
const zeroBalance = async () => ({ isZero: () => true }) as unknown as USDAmount
const nonzeroBalance = async () => ({ isZero: () => false }) as unknown as USDAmount

const client: CashWalletClientCapabilities = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
}

describe("presentation self-heal (ENG-544)", () => {
  beforeEach(() => jest.clearAllMocks())

  it("creates the missing USDT wallet and resolves against it", async () => {
    // The account that could not be paid: usdt presentation, no usdt wallet.
    mockEnsureUsdtWallet.mockResolvedValue(usdtWallet)
    const walletsRepo = walletsRepoWith([btcWallet, usdWallet])

    const result = await resolveCashWalletPresentationForAccount({
      account: ACCOUNT,
      client,
      migrationsRepo,
      walletsRepo,
    })

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) throw result
    expect(result.defaultWalletId).toBe("usdt-1")
    expect(result.activeSettlementWallet.id).toBe("usdt-1")
    // The heal's reads must go through the SAME repo the resolver reads from
    // — a caller injecting a scoped/instrumented repo must not get heal
    // traffic through a different one.
    expect(mockEnsureUsdtWallet).toHaveBeenCalledWith({ account: ACCOUNT, walletsRepo })
  })

  it("heals the legacy_usd_compat presentation too — old client, cutover complete", async () => {
    // guard.ts: a client WITHOUT usdt support after cutover completion gets
    // "legacy_usd_compat", and presentation.ts errors on a missing USDT
    // wallet there as well (it is the active settlement wallet). If the heal
    // trigger is ever narrowed to the "usdt" presentation, this fails.
    mockEnsureUsdtWallet.mockResolvedValue(usdtWallet)
    const walletsRepo = walletsRepoWith([btcWallet, usdWallet])

    const result = await resolveCashWalletPresentationForAccount({
      account: ACCOUNT,
      client: {
        cashWalletPresentation: "legacy_compat",
        hasUsdtCashWalletSupport: false,
      },
      migrationsRepo,
      walletsRepo,
    })

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) throw result
    expect(mockEnsureUsdtWallet).toHaveBeenCalledWith({ account: ACCOUNT, walletsRepo })
    // Compat keeps presenting the legacy USD wallet to the old client…
    expect(result.defaultWalletId).toBe("usd-1")
    // …but settles on the healed USDT wallet.
    expect(result.activeSettlementWallet.id).toBe("usdt-1")
  })

  it("preserves the original error when creation fails — degraded, never worse", async () => {
    mockEnsureUsdtWallet.mockResolvedValue(null)

    const result = await resolveCashWalletPresentationForAccount({
      account: ACCOUNT,
      client,
      migrationsRepo,
      walletsRepo: walletsRepoWith([btcWallet, usdWallet]),
      legacyUsdBalance: zeroBalance,
    })

    expect(result).toBeInstanceOf(CashWalletMissingUsdtWalletError)
  })

  it("never invokes creation when the USDT wallet already exists", async () => {
    // The steady state must stay a pure read: the self-heal is for the
    // one-time convergence, not a write on every resolution.
    const result = await resolveCashWalletPresentationForAccount({
      account: ACCOUNT,
      client,
      migrationsRepo,
      walletsRepo: walletsRepoWith([btcWallet, usdWallet, usdtWallet]),
    })

    expect(result).not.toBeInstanceOf(Error)
    expect(mockEnsureUsdtWallet).not.toHaveBeenCalled()
  })

  it("refuses to heal a nonzero legacy balance under the usdt presentation", async () => {
    // THE MONEY CASE. The usdt presentation hides the legacy wallet — its
    // balance resolver redirects to the settlement wallet — so healing an
    // account that still holds legacy funds would show the customer an empty
    // cash wallet with their money out of sight. Those accounts keep the
    // original error and stay on the operator queue: moving their money is a
    // migration run, not a lazy write on the resolution path.
    mockEnsureUsdtWallet.mockResolvedValue(usdtWallet)

    const result = await resolveCashWalletPresentationForAccount({
      account: ACCOUNT,
      client,
      migrationsRepo,
      walletsRepo: walletsRepoWith([btcWallet, usdWallet]),
      legacyUsdBalance: nonzeroBalance,
    })

    expect(result).toBeInstanceOf(CashWalletMissingUsdtWalletError)
    expect(mockEnsureUsdtWallet).not.toHaveBeenCalled()
  })

  it("refuses to heal when the legacy balance cannot be read — creating blind is the flip the gate prevents", async () => {
    mockEnsureUsdtWallet.mockResolvedValue(usdtWallet)

    const result = await resolveCashWalletPresentationForAccount({
      account: ACCOUNT,
      client,
      migrationsRepo,
      walletsRepo: walletsRepoWith([btcWallet, usdWallet]),
      legacyUsdBalance: async () => new Error("ibex unreachable") as unknown as USDAmount,
    })

    expect(result).toBeInstanceOf(CashWalletMissingUsdtWalletError)
    expect(mockEnsureUsdtWallet).not.toHaveBeenCalled()
  })

  it("heals without a balance read when the account has no legacy wallet at all", async () => {
    // Nothing to hide, nothing to consult.
    mockEnsureUsdtWallet.mockResolvedValue(usdtWallet)
    const balanceReader = jest.fn(nonzeroBalance)

    const result = await resolveCashWalletPresentationForAccount({
      account: ACCOUNT,
      client,
      migrationsRepo,
      walletsRepo: walletsRepoWith([btcWallet]),
      legacyUsdBalance: balanceReader,
    })

    expect(result).not.toBeInstanceOf(Error)
    expect(balanceReader).not.toHaveBeenCalled()
    expect(mockEnsureUsdtWallet).toHaveBeenCalled()
  })
})
