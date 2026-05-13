import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import { USDTAmount, WalletCurrency } from "@domain/shared"
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
})
