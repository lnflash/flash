import { createAccountWithPhoneIdentifier } from "@app/accounts/create-account"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import { AccountLevel } from "@domain/accounts"
import { WalletCurrency } from "@domain/shared"
import { PersistError } from "@domain/errors"
import { WalletType } from "@domain/wallets"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import {
  AccountsRepository,
  UsersRepository,
  WalletsRepository,
} from "@services/mongoose"

jest.mock("@config", () => ({
  getAdminAccounts: jest.fn(() => []),
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(),
  UsersRepository: jest.fn(),
  WalletsRepository: jest.fn(),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getEthereumUsdtOption: jest.fn(),
    createCryptoReceiveInfo: jest.fn(),
  },
}))

const mockedAccountsRepository = AccountsRepository as jest.MockedFunction<
  typeof AccountsRepository
>
const mockedUsersRepository = UsersRepository as jest.MockedFunction<
  typeof UsersRepository
>
const mockedWalletsRepository = WalletsRepository as jest.MockedFunction<
  typeof WalletsRepository
>

describe("createAccountWithPhoneIdentifier", () => {
  let persistNew: jest.Mock
  let updateAccount: jest.Mock

  const account = {
    id: "account-id" as AccountId,
    defaultWalletId: undefined,
  } as Account

  const config = {
    initialWallets: [WalletCurrency.Usd],
    initialStatus: "active",
    initialLevel: AccountLevel.One,
  } as AccountsConfig

  beforeEach(() => {
    jest.clearAllMocks()

    mockedUsersRepository.mockReturnValue({
      update: jest.fn().mockResolvedValue({ id: "user-id" }),
    } as unknown as ReturnType<typeof UsersRepository>)

    updateAccount = jest
      .fn()
      .mockImplementation(async (updatedAccount: Account) => updatedAccount)

    mockedAccountsRepository.mockReturnValue({
      persistNew: jest.fn().mockResolvedValue({ ...account }),
      update: updateAccount,
    } as unknown as ReturnType<typeof AccountsRepository>)

    jest.mocked(Ibex.getEthereumUsdtOption).mockResolvedValue({
      id: "eth-usdt-option",
      currency: "USDT",
      network: "ethereum",
      name: "Ethereum USDT",
    })
    jest.mocked(Ibex.createCryptoReceiveInfo).mockResolvedValue({
      id: "receive-info-id",
      wallet_id: `${WalletCurrency.Usdt}-wallet-id`,
      option_id: "eth-usdt-option",
      address: "0xeth-usdt-address",
      currency: "USDT",
      network: "ethereum",
      created_at: "2026-05-12T00:00:00Z",
    })

    persistNew = jest.fn().mockImplementation(async ({ accountId, type, currency }) => ({
      id: `${currency}-wallet-id`,
      accountId,
      type,
      currency,
    }))

    mockedWalletsRepository.mockReturnValue({
      persistNew,
    } as unknown as ReturnType<typeof WalletsRepository>)
  })

  it("creates both USD and USDT cash wallets and defaults new accounts to USDT", async () => {
    const result = await createAccountWithPhoneIdentifier({
      newAccountInfo: {
        kratosUserId: "kratos-user-id" as UserId,
        phone: "+15551234567" as PhoneNumber,
      },
      config,
    })

    expect(result).not.toBeInstanceOf(Error)

    expect(persistNew).toHaveBeenCalledWith({
      accountId: account.id,
      type: WalletType.Checking,
      currency: WalletCurrency.Usd,
    })
    expect(persistNew).toHaveBeenCalledWith({
      accountId: account.id,
      type: WalletType.Checking,
      currency: WalletCurrency.Usdt,
    })
    expect(persistNew).toHaveBeenCalledTimes(2)
    expect((result as Account).defaultWalletId).toBe(`${WalletCurrency.Usdt}-wallet-id`)
  })

  it("creates one Ethereum USDT receive address for the new USDT cash wallet", async () => {
    const result = await createAccountWithPhoneIdentifier({
      newAccountInfo: {
        kratosUserId: "kratos-user-id" as UserId,
        phone: "+15551234567" as PhoneNumber,
      },
      config,
    })

    expect(result).not.toBeInstanceOf(Error)
    expect(Ibex.getEthereumUsdtOption).toHaveBeenCalledTimes(1)
    expect(Ibex.createCryptoReceiveInfo).toHaveBeenCalledWith(
      `${WalletCurrency.Usdt}-wallet-id`,
      expect.objectContaining({ name: account.id, network: "ethereum" }),
    )
    expect(updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeEthereumAddress: "0xeth-usdt-address" }),
    )
    expect((result as Account).bridgeEthereumAddress).toBe("0xeth-usdt-address")
  })

  it("keeps the new account usable if the Ethereum USDT receive address cannot be created", async () => {
    jest
      .mocked(Ibex.createCryptoReceiveInfo)
      .mockResolvedValueOnce(new IbexError(new Error("receive-info failed")))

    const result = await createAccountWithPhoneIdentifier({
      newAccountInfo: {
        kratosUserId: "kratos-user-id" as UserId,
        phone: "+15551234567" as PhoneNumber,
      },
      config,
    })

    expect(result).not.toBeInstanceOf(Error)
    expect((result as Account).defaultWalletId).toBe(`${WalletCurrency.Usdt}-wallet-id`)
    expect(updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ defaultWalletId: `${WalletCurrency.Usdt}-wallet-id` }),
    )
    expect(recordExceptionInCurrentSpan).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(IbexError) }),
    )
  })

  it("does not create an account with a USD fallback default if the USDT wallet is missing", async () => {
    persistNew.mockImplementation(async ({ accountId, type, currency }) => {
      if (currency === WalletCurrency.Usdt) return new PersistError("USDT wallet failed")
      return {
        id: `${currency}-wallet-id`,
        accountId,
        type,
        currency,
      }
    })

    const result = await createAccountWithPhoneIdentifier({
      newAccountInfo: {
        kratosUserId: "kratos-user-id" as UserId,
        phone: "+15551234567" as PhoneNumber,
      },
      config,
    })

    expect(result).toBeInstanceOf(Error)
  })
})
