// jest.mock calls are hoisted before imports

const mockEnsureUsdtWallet = jest.fn()

jest.mock("@app/cash-wallet-cutover/ensure-usdt-wallet", () => ({
  ensureUsdtWalletForAccount: (...args: unknown[]) => mockEnsureUsdtWallet(...args),
}))
// The resolver imports the real repos as defaults; both are injected per test.
jest.mock("@services/mongoose", () => ({
  WalletsRepository: () => ({}),
  CashWalletCutoverRepository: () => ({}),
}))

import { WalletCurrency } from "@domain/shared"
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
// mis-shaped this silently decides "legacy_usd_compat" instead of "usdt" —
// which ALSO errors on a missing USDT wallet, so the self-heal covers both;
// the fixtures pin the real shape so the assertions name the right wallet.
const client: CashWalletClientCapabilities = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
}

describe("presentation self-heal (ENG-544)", () => {
  beforeEach(() => jest.clearAllMocks())

  it("creates the missing USDT wallet and resolves against it", async () => {
    // The account that could not be paid: usdt presentation, no usdt wallet.
    mockEnsureUsdtWallet.mockResolvedValue(usdtWallet)

    const result = await resolveCashWalletPresentationForAccount({
      account: ACCOUNT,
      client,
      migrationsRepo,
      walletsRepo: walletsRepoWith([btcWallet, usdWallet]),
    })

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) throw result
    expect(result.defaultWalletId).toBe("usdt-1")
    expect(result.activeSettlementWallet.id).toBe("usdt-1")
    expect(mockEnsureUsdtWallet).toHaveBeenCalledWith({ account: ACCOUNT })
  })

  it("preserves the original error when creation fails — degraded, never worse", async () => {
    mockEnsureUsdtWallet.mockResolvedValue(null)

    const result = await resolveCashWalletPresentationForAccount({
      account: ACCOUNT,
      client,
      migrationsRepo,
      walletsRepo: walletsRepoWith([btcWallet, usdWallet]),
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
})
