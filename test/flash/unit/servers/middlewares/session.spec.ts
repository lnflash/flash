import { Accounts } from "@app"
import { createAccountWithPhoneIdentifier } from "@app/accounts"
import {
  CouldNotFindAccountFromKratosIdError,
  DuplicateKeyForPersistError,
} from "@domain/errors"
import { sessionPublicContext } from "@servers/middlewares/session"
import { IdentityRepository, UnknownKratosError } from "@services/kratos"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { recordExceptionInCurrentSpan } from "@services/tracing"

jest.mock("@app", () => ({
  Accounts: {
    getAccountFromUserId: jest.fn(),
    updateAccountIPsInfo: jest.fn(),
  },
  Transactions: {
    getTransactionsMetadataByIds: jest.fn(),
  },
}))

jest.mock("@app/accounts", () => ({
  createAccountWithPhoneIdentifier: jest.fn(),
}))

jest.mock("@app/authentication", () => ({
  maybeExtendSession: jest.fn(),
}))

jest.mock("@app/cash-wallet-cutover", () => ({
  DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES: {
    cashWalletPresentation: "legacy_compat",
    hasUsdtCashWalletSupport: false,
  },
}))

// Identity mapping is what is under test here, not the GraphQL error shape:
// pass domain errors through so the rejection can be asserted directly.
jest.mock("@graphql/error-map", () => ({
  mapError: jest.fn((err) => err),
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: jest.fn(),
  UnknownKratosError: class UnknownKratosError extends Error {},
}))

jest.mock("@services/mongoose", () => ({
  UsersRepository: jest.fn(),
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/logger", () => {
  const child = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
  return {
    baseLogger: { ...child, child: jest.fn(() => child) },
  }
})

const mockedGetAccount = Accounts.getAccountFromUserId as jest.MockedFunction<
  typeof Accounts.getAccountFromUserId
>
const mockedCreateAccount = createAccountWithPhoneIdentifier as jest.MockedFunction<
  typeof createAccountWithPhoneIdentifier
>
const mockedIdentityRepository = IdentityRepository as jest.MockedFunction<
  typeof IdentityRepository
>
const mockedUsersRepository = UsersRepository as jest.MockedFunction<
  typeof UsersRepository
>
const mockedRecordException = recordExceptionInCurrentSpan as jest.MockedFunction<
  typeof recordExceptionInCurrentSpan
>
const childLogger = (
  baseLogger as unknown as { child: () => { warn: jest.Mock } }
).child()

const kratosUserId = "ebbe2b32-9a2e-4c77-80e4-5d7347c024bb" as UserId
const phone = "+2348012345678" as PhoneNumber
const ip = "203.0.113.7" as IpAddress

const account = {
  id: "6a972befef5ea964adc2548f",
  kratosUserId,
  username: "alice",
} as unknown as Account
const user = { id: kratosUserId, phone } as unknown as User

const getIdentity = jest.fn()

const tokenPayload = { sub: kratosUserId, session_id: "sess", expires_at: "later" }

describe("sessionPublicContext", () => {
  beforeEach(() => {
    mockedGetAccount.mockReset()
    mockedCreateAccount.mockReset()
    mockedRecordException.mockReset()
    getIdentity.mockReset()
    childLogger.warn.mockReset()
    mockedIdentityRepository.mockReturnValue({
      getIdentity,
    } as unknown as ReturnType<typeof IdentityRepository>)
    mockedUsersRepository.mockReturnValue({
      findById: jest.fn().mockResolvedValue(user),
    } as unknown as ReturnType<typeof UsersRepository>)
  })

  it("resolves an existing account without touching kratos", async () => {
    mockedGetAccount.mockResolvedValue(account)

    const context = await sessionPublicContext({ tokenPayload, ip })

    expect(context.domainAccount).toBe(account)
    expect(context.user).toBe(user)
    expect(mockedIdentityRepository).not.toHaveBeenCalled()
    expect(mockedCreateAccount).not.toHaveBeenCalled()
  })

  it("leaves an anonymous subject without an account and without lookups", async () => {
    const context = await sessionPublicContext({
      tokenPayload: { sub: "anon" },
      ip,
    })

    expect(context.domainAccount).toBeUndefined()
    expect(context.user).toBeUndefined()
    expect(mockedGetAccount).not.toHaveBeenCalled()
  })

  describe("orphaned kratos identity (identity committed, account write failed)", () => {
    const orphan = new CouldNotFindAccountFromKratosIdError(kratosUserId)

    beforeEach(() => {
      mockedGetAccount.mockResolvedValue(orphan)
    })

    it("repairs it from the identity's phone trait and continues as that account", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone })
      mockedCreateAccount.mockResolvedValue(account)

      const context = await sessionPublicContext({ tokenPayload, ip })

      expect(mockedCreateAccount).toHaveBeenCalledWith({
        newAccountInfo: { kratosUserId, phone },
        config: expect.any(Object),
      })
      expect(context.domainAccount).toBe(account)
      expect(context.user).toBe(user)
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ kratosUserId, accountId: account.id }),
        "orphaned kratos identity repaired",
      )
    })

    it("re-raises the original error when the identity has no phone trait", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone: undefined })

      await expect(sessionPublicContext({ tokenPayload, ip })).rejects.toBe(orphan)

      expect(mockedCreateAccount).not.toHaveBeenCalled()
    })

    it("re-raises the original error when the identity cannot be loaded", async () => {
      getIdentity.mockResolvedValue(new UnknownKratosError("kratos down"))

      await expect(sessionPublicContext({ tokenPayload, ip })).rejects.toBe(orphan)

      expect(mockedCreateAccount).not.toHaveBeenCalled()
    })

    it("re-raises the original error when the repair write fails, and records it", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone })
      const collision = new DuplicateKeyForPersistError(
        "E11000 duplicate key error collection: galoy.users index: phone_1",
      )
      mockedCreateAccount.mockResolvedValue(collision)

      await expect(sessionPublicContext({ tokenPayload, ip })).rejects.toBe(orphan)

      expect(mockedRecordException).toHaveBeenCalledWith(
        expect.objectContaining({
          error: collision,
          attributes: { kratosUserId },
        }),
      )
    })
  })
})
