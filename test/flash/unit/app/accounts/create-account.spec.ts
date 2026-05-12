import { createAccountWithPhoneIdentifier } from "@app/accounts/create-account"
import { AccountLevel } from "@domain/accounts"
import { WalletCurrency } from "@domain/shared"
import { PersistError } from "@domain/errors"
import { WalletType } from "@domain/wallets"
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

    mockedAccountsRepository.mockReturnValue({
      persistNew: jest.fn().mockResolvedValue({ ...account }),
      update: jest
        .fn()
        .mockImplementation(async (updatedAccount: Account) => updatedAccount),
    } as unknown as ReturnType<typeof AccountsRepository>)

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
