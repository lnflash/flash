const mockFindAccountByUsername = jest.fn()
const mockHasEnabledSplits = jest.fn()
const mockEnsureReceiveAccount = jest.fn()

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({
    findByUsername: (...args: unknown[]) => mockFindAccountByUsername(...args),
  })),
}))

jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletPresentationForAccount: jest.fn(async ({ account }) => ({
    wallets: [
      {
        id: WALLET,
        accountId: account.id,
        currency: WalletCurrency.Usdt,
        lnurlp: OWN_LNURL,
      },
    ],
    defaultWalletId: WALLET,
    activeSettlementWallet: { id: WALLET, currency: WalletCurrency.Usdt },
  })),
}))

jest.mock("@app/payment-splits/receive-account", () => ({
  hasEnabledSplits: (...args: unknown[]) => mockHasEnabledSplits(...args),
  ensureReceiveAccount: (...args: unknown[]) => mockEnsureReceiveAccount(...args),
}))

jest.mock("@services/notifications", () => ({
  NotificationsService: jest.fn(() => ({})),
}))

import { WalletCurrency } from "@domain/shared"
import AccountDefaultWalletQuery from "@graphql/public/root/query/account-default-wallet"

const WALLET = "11111111-1111-4111-8111-111111111111"
const OWN_LNURL = "lnurl1own-wallet"
const SHADOW_LNURL = "lnurl1shadow"
const USERNAME = "merchant"

const resolve = async (walletCurrency?: unknown) =>
  (
    AccountDefaultWalletQuery as unknown as {
      resolve: (
        s: null,
        a: { username: unknown; walletCurrency: unknown },
        c: { cashWalletClientCapabilities: unknown },
      ) => Promise<unknown>
    }
  ).resolve(
    null,
    { username: USERNAME, walletCurrency },
    {
      cashWalletClientCapabilities: { cashWalletUsdt: true },
    },
  )

beforeEach(() => {
  jest.clearAllMocks()
  mockFindAccountByUsername.mockResolvedValue({ id: "owner-account" })
  mockHasEnabledSplits.mockResolvedValue(false)
})

describe("accountDefaultWallet.lnurlp shadow routing (ENG-717)", () => {
  it("serves the wallet's own lnurlp when it has no enabled splits", async () => {
    const wallet = (await resolve("USDT")) as { lnurlp: string }

    expect(wallet.lnurlp).toBe(OWN_LNURL)
    expect(mockEnsureReceiveAccount).not.toHaveBeenCalled()
  })

  it("serves the shadow's lnurlp when the wallet has enabled splits", async () => {
    mockHasEnabledSplits.mockResolvedValue(true)
    mockEnsureReceiveAccount.mockResolvedValue({
      walletId: WALLET,
      ibexAccountId: "shadow-account",
      currency: "USDT",
      lnurlp: SHADOW_LNURL,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const wallet = (await resolve("USDT")) as { lnurlp: string }

    expect(wallet.lnurlp).toBe(SHADOW_LNURL)
    expect(mockEnsureReceiveAccount).toHaveBeenCalledWith({
      walletId: WALLET,
      currency: WalletCurrency.Usdt,
    })
  })

  it("falls back to the wallet's own lnurlp when the shadow has no lnurlp", async () => {
    mockHasEnabledSplits.mockResolvedValue(true)
    mockEnsureReceiveAccount.mockResolvedValue({
      walletId: WALLET,
      ibexAccountId: "shadow-account",
      currency: "USDT",
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const wallet = (await resolve("USDT")) as { lnurlp: string }

    expect(wallet.lnurlp).toBe(OWN_LNURL)
  })

  it("falls back to the wallet's own lnurlp when the ensure errors (fail-safe: unsplit receive)", async () => {
    mockHasEnabledSplits.mockResolvedValue(true)
    mockEnsureReceiveAccount.mockResolvedValue(new Error("ibex down"))

    const wallet = (await resolve("USDT")) as { lnurlp: string }

    expect(wallet.lnurlp).toBe(OWN_LNURL)
  })

  it("routes the default-wallet shape (no walletCurrency) too", async () => {
    mockHasEnabledSplits.mockResolvedValue(true)
    mockEnsureReceiveAccount.mockResolvedValue({
      walletId: WALLET,
      ibexAccountId: "shadow-account",
      currency: "USDT",
      lnurlp: SHADOW_LNURL,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const wallet = (await resolve()) as { lnurlp: string }

    expect(wallet.lnurlp).toBe(SHADOW_LNURL)
  })
})
