import { UnsupportedCurrencyError } from "@domain/errors"
import { WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { AccountsRepository } from "@services/mongoose/accounts"
import { WalletsRepository } from "@services/mongoose/wallets"

const save = jest.fn()
const walletConstructor = jest.fn().mockImplementation((record) => ({
  ...record,
  save,
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    createAccount: jest.fn(),
    createLnurlPay: jest.fn(),
  },
}))

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/mongoose/schema", () => ({
  Wallet: jest.fn().mockImplementation((record) => walletConstructor(record)),
}))

jest.mock("@services/mongoose/utils", () => ({
  toObjectId: jest.fn((id) => id),
  fromObjectId: jest.fn((id) => id),
  parseRepositoryError: jest.fn((err) => err),
}))

describe("WalletsRepository.persistNew", () => {
  beforeEach(() => {
    save.mockReset().mockResolvedValue(undefined)
    walletConstructor.mockClear()
    jest.mocked(AccountsRepository).mockReturnValue({
      findById: jest.fn().mockResolvedValue({ id: "account-id" }),
    } as never)
    jest
      .mocked(Ibex.createAccount)
      .mockReset()
      .mockResolvedValue({
        id: "ibex-account-id",
      } as never)
    jest
      .mocked(Ibex.createLnurlPay)
      .mockReset()
      .mockResolvedValue({
        lnurl: "lnurlp",
      } as never)
  })

  it("rejects currencies without an IBEX account currency id", async () => {
    const result = await WalletsRepository().persistNew({
      accountId: "account-id" as AccountId,
      type: "checking" as WalletType,
      currency: WalletCurrency.Btc,
    })

    expect(result).toBeInstanceOf(UnsupportedCurrencyError)
    expect(Ibex.createAccount).not.toHaveBeenCalled()
    expect(Ibex.createLnurlPay).not.toHaveBeenCalled()
  })

  it("creates USDT wallets as IBEX currency 29 accounts", async () => {
    const result = await WalletsRepository().persistNew({
      accountId: "account-id" as AccountId,
      type: "checking" as WalletType,
      currency: WalletCurrency.Usdt,
    })

    expect(result).not.toBeInstanceOf(Error)
    expect(Ibex.createAccount).toHaveBeenCalledWith("account-id", 29)
    expect(Ibex.createLnurlPay).toHaveBeenCalledWith({
      accountId: "ibex-account-id",
      currencyId: 29,
    })
  })
})
