jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { getAccountDetails: jest.fn() },
}))

import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"

const WALLET_ID = "wallet-001" as WalletId

describe("getBalanceForWallet", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("reads USDT wallet balances from the IBEX account details endpoint", async () => {
    const balance = USDTAmount.fromNumber("12.34")
    expect(balance).not.toBeInstanceOf(Error)
    ;(Ibex.getAccountDetails as jest.Mock).mockResolvedValue({ balance })

    const result = await getBalanceForWallet({
      walletId: WALLET_ID,
      currency: WalletCurrency.Usdt,
    })

    expect(Ibex.getAccountDetails).toHaveBeenCalledWith(WALLET_ID, WalletCurrency.Usdt)
    expect(result).toBe(balance)
  })

  it("returns zero USDT when the IBEX USDT account is missing", async () => {
    const notFound = Object.assign(new IbexError(new Error("not found")), {
      httpCode: 404,
    })
    ;(Ibex.getAccountDetails as jest.Mock).mockResolvedValue(notFound)

    const result = await getBalanceForWallet({
      walletId: WALLET_ID,
      currency: WalletCurrency.Usdt,
    })

    expect(result).toBe(USDTAmount.ZERO)
  })

  it("keeps USD 404 fallback behavior", async () => {
    const notFound = Object.assign(new IbexError(new Error("not found")), {
      httpCode: 404,
    })
    ;(Ibex.getAccountDetails as jest.Mock).mockResolvedValue(notFound)

    const result = await getBalanceForWallet({
      walletId: WALLET_ID,
      currency: WalletCurrency.Usd,
    })

    expect(result).toBe(USDAmount.ZERO)
  })
})
