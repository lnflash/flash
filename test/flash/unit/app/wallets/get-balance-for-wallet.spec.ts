import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"

const mockGetWalletBalance = jest.fn()
const mockUsdFromBtcMidPriceFn = jest.fn()

jest.mock("@services/ledger", () => ({
  LedgerService: () => ({
    getWalletBalance: (...args: Parameters<typeof mockGetWalletBalance>) =>
      mockGetWalletBalance(...args),
  }),
}))

// The mid-price helper opens its own span and calls the dealer service; the
// unit harness only needs the conversion it performs on the ledger figure.
jest.mock("@app/prices/mid-price", () => ({
  usdFromBtcMidPriceFn: (...args: Parameters<typeof mockUsdFromBtcMidPriceFn>) =>
    mockUsdFromBtcMidPriceFn(...args),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getAccountDetails: jest.fn(),
    getCryptoReceiveBalance: jest.fn(),
  },
}))

import {
  markIbexUnavailable,
  resetIbexAvailability,
} from "@services/ibex/availability"

describe("getBalanceForWallet", () => {
  beforeEach(() => {
    jest.mocked(Ibex.getAccountDetails).mockReset()
    jest.mocked(Ibex.getCryptoReceiveBalance).mockReset()
    jest.mocked(mockGetWalletBalance).mockReset()
    jest.mocked(mockUsdFromBtcMidPriceFn).mockReset()
    resetIbexAvailability()
  })

  it("loads USDT balances from the IBEX account id, not a crypto receive-info id", async () => {
    const balance = USDTAmount.ZERO
    jest.mocked(Ibex.getAccountDetails).mockResolvedValue({
      id: "ibex-account-id",
      balance,
    } as never)

    const result = await getBalanceForWallet({
      walletId: "ibex-account-id" as WalletId,
      currency: WalletCurrency.Usdt,
    })

    expect(Ibex.getAccountDetails).toHaveBeenCalledWith(
      "ibex-account-id",
      WalletCurrency.Usdt,
    )
    expect(Ibex.getCryptoReceiveBalance).not.toHaveBeenCalled()
    expect(result).toBe(balance)
  })

  // IBEX omits `balance` on drained / never-funded accounts (absent means zero —
  // verified in prod during the USDT cutover). Post-cutover every migrated
  // account's legacy USD wallet reads this way; it must resolve to zero, not an
  // error (an error here broke admin-API wallets[].balance for all migrated
  // accounts, since the compat redirect never runs in admin ctx).
  it("treats a missing balance field as zero for USD (drained legacy wallet)", async () => {
    jest.mocked(Ibex.getAccountDetails).mockResolvedValue({
      id: "drained-usd-ibex-id",
    } as never)

    const result = await getBalanceForWallet({
      walletId: "drained-usd-ibex-id" as WalletId,
      currency: WalletCurrency.Usd,
    })

    expect(result).toBe(USDAmount.ZERO)
  })

  it("treats a missing balance field as zero for USDT", async () => {
    jest.mocked(Ibex.getAccountDetails).mockResolvedValue({
      id: "drained-usdt-ibex-id",
    } as never)

    const result = await getBalanceForWallet({
      walletId: "drained-usdt-ibex-id" as WalletId,
      currency: WalletCurrency.Usdt,
    })

    expect(result).toBe(USDTAmount.ZERO)
  })

  // Circuit open (an unanswered IBEX call, see @services/ibex/availability):
  // a BTC wallet is still fully readable from the mongo ledger, so the wallet
  // screen keeps its numbers instead of failing on the cash rail.
  it("reads a BTC balance from the ledger while IBEX is unavailable", async () => {
    markIbexUnavailable()
    mockGetWalletBalance.mockResolvedValue(1000)
    mockUsdFromBtcMidPriceFn.mockResolvedValue({
      currency: WalletCurrency.Usd,
      amount: 42n,
    })

    const result = await getBalanceForWallet({
      walletId: "btc-wallet-id" as WalletId,
      currency: WalletCurrency.Btc,
    })

    expect(Ibex.getAccountDetails).not.toHaveBeenCalled()
    expect(mockGetWalletBalance).toHaveBeenCalledWith("btc-wallet-id")
    expect(mockUsdFromBtcMidPriceFn).toHaveBeenCalledWith({
      currency: WalletCurrency.Btc,
      amount: 1000n,
    })
    expect(result).toBeInstanceOf(USDAmount)
    expect((result as USDAmount).asCents()).toBe("42")
  })

  it("propagates a ledger failure on the degraded BTC path", async () => {
    markIbexUnavailable()
    mockGetWalletBalance.mockResolvedValue(new Error("mongo down"))

    const result = await getBalanceForWallet({
      walletId: "btc-wallet-id" as WalletId,
      currency: WalletCurrency.Btc,
    })

    expect(result).toBeInstanceOf(Error)
  })

  // Cash balances are only authoritative at IBEX: a stale ledger figure would
  // be worse than an honest "unavailable", which the wallet resolvers render
  // as a null balance rather than an error.
  it("reports a cash balance as unavailable instead of reading the ledger", async () => {
    markIbexUnavailable()

    const result = await getBalanceForWallet({
      walletId: "usd-wallet-id" as WalletId,
      currency: WalletCurrency.Usd,
    })

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).name).toBe("IbexUnavailableError")
    expect(mockGetWalletBalance).not.toHaveBeenCalled()
    expect(Ibex.getAccountDetails).not.toHaveBeenCalled()
  })
})
