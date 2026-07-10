import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getAccountDetails: jest.fn(),
    getCryptoReceiveBalance: jest.fn(),
  },
}))

describe("getBalanceForWallet", () => {
  beforeEach(() => {
    jest.mocked(Ibex.getAccountDetails).mockReset()
    jest.mocked(Ibex.getCryptoReceiveBalance).mockReset()
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
})
