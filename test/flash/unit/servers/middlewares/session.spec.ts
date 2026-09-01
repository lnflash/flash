import { Accounts } from "@app"
import { createAccountWithPhoneIdentifier } from "@app/accounts"
import {
  CouldNotFindAccountFromKratosIdError,
  DuplicateKeyForPersistError,
  UnknownRepositoryError,
} from "@domain/errors"
import { UnknownPhoneProviderServiceError } from "@domain/phone-provider"
import { ErrorLevel } from "@domain/shared"
import { AuthenticationError } from "@graphql/error"
import {
  clearOrphanRepairState,
  sessionPublicContext,
} from "@servers/middlewares/session"
import { IdentityRepository, UnknownKratosError } from "@services/kratos"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import { TwilioClient } from "@services/twilio"

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

jest.mock("@services/twilio", () => ({
  TwilioClient: jest.fn(),
}))

// The real error map runs (no mock): what the client is answered with is part
// of what is under test. CustomApolloError binds `logger[level]`, so every
// pino level it can name has to exist on the mock.
jest.mock("@services/logger", () => {
  const child = {
    fatal: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }
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
const mockedTwilioClient = TwilioClient as jest.MockedFunction<typeof TwilioClient>
const childLogger = (
  baseLogger as unknown as {
    child: () => { error: jest.Mock; warn: jest.Mock; debug: jest.Mock }
  }
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

// What the registration webhook stores on the users row from Twilio's carrier
// lookup (login.ts → transient_payload → RegistrationPayloadValidator).
const phoneMetadata = {
  carrier: {
    error_code: "",
    mobile_country_code: "621",
    mobile_network_code: "30",
    name: "MTN Nigeria",
    type: "mobile",
  },
  countryCode: "NG",
} as PhoneMetadata

const getIdentity = jest.fn()
const getCarrier = jest.fn()

const tokenPayload = { sub: kratosUserId, session_id: "sess", expires_at: "later" }

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve))

// The caller's own session with no account is answered as NOT_AUTHENTICATED:
// the client must not retry it as a transient fault, and must not be told the
// account "does not exist for user id …" as an admin looking up someone else
// would be.
const expectNotAuthenticated = async (attempt: Promise<unknown>) => {
  await expect(attempt).rejects.toBeInstanceOf(AuthenticationError)
  await expect(attempt).rejects.toMatchObject({
    message: "No account is linked to this session",
    extensions: { code: "NOT_AUTHENTICATED" },
  })
}

describe("sessionPublicContext", () => {
  beforeEach(() => {
    clearOrphanRepairState()
    mockedGetAccount.mockReset()
    mockedCreateAccount.mockReset()
    mockedRecordException.mockReset()
    mockedIdentityRepository.mockReset()
    mockedTwilioClient.mockReset()
    getIdentity.mockReset()
    getCarrier.mockReset()
    childLogger.error.mockReset()
    childLogger.warn.mockReset()
    childLogger.debug.mockReset()
    mockedIdentityRepository.mockReturnValue({
      getIdentity,
    } as unknown as ReturnType<typeof IdentityRepository>)
    mockedTwilioClient.mockReturnValue({
      getCarrier,
    } as unknown as ReturnType<typeof TwilioClient>)
    mockedUsersRepository.mockReturnValue({
      findById: jest.fn().mockResolvedValue(user),
    } as unknown as ReturnType<typeof UsersRepository>)
  })

  afterEach(() => {
    jest.useRealTimers()
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

  it("maps any other lookup failure through the error map and does not try to repair", async () => {
    mockedGetAccount.mockResolvedValue(new UnknownRepositoryError("mongo unreachable"))

    const attempt = sessionPublicContext({ tokenPayload, ip })

    await expect(attempt).rejects.not.toBeInstanceOf(AuthenticationError)
    await expect(attempt).rejects.toMatchObject({ extensions: { code: "DB_ERROR" } })
    expect(mockedIdentityRepository).not.toHaveBeenCalled()
    expect(mockedCreateAccount).not.toHaveBeenCalled()
  })

  describe("orphaned kratos identity (identity committed, account write failed)", () => {
    const orphan = new CouldNotFindAccountFromKratosIdError(kratosUserId)

    beforeEach(() => {
      mockedGetAccount.mockResolvedValue(orphan)
      getCarrier.mockResolvedValue(phoneMetadata)
    })

    it("repairs it from the identity's phone trait and continues as that account", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone })
      mockedCreateAccount.mockResolvedValue(account)

      const context = await sessionPublicContext({ tokenPayload, ip })

      expect(mockedCreateAccount).toHaveBeenCalledWith({
        newAccountInfo: { kratosUserId, phone },
        config: expect.any(Object),
        phoneMetadata,
      })
      expect(context.domainAccount).toBe(account)
      expect(context.user).toBe(user)
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ kratosUserId, accountId: account.id }),
        "orphaned kratos identity repaired",
      )
      expect(mockedRecordException).not.toHaveBeenCalled()
    })

    // The webhook path stores Twilio's carrier lookup as users.phoneMetadata.
    // Quiz rewards (add-earn → PhoneMetadataAuthorizer) fail closed when it is
    // missing, so a repair that skipped the lookup would leave the account
    // permanently ineligible for rewards with nothing pointing at why.
    it("looks up the carrier and stores it with the repair, as the registration webhook would", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone })
      mockedCreateAccount.mockResolvedValue(account)

      await sessionPublicContext({ tokenPayload, ip })

      expect(getCarrier).toHaveBeenCalledTimes(1)
      expect(getCarrier).toHaveBeenCalledWith(phone)
      expect(mockedCreateAccount).toHaveBeenCalledWith(
        expect.objectContaining({ phoneMetadata }),
      )
    })

    it("still repairs when the carrier lookup fails, just without phone metadata", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone })
      const lookupFailed = new UnknownPhoneProviderServiceError("twilio lookups down")
      getCarrier.mockResolvedValue(lookupFailed)
      mockedCreateAccount.mockResolvedValue(account)

      const context = await sessionPublicContext({ tokenPayload, ip })

      expect(context.domainAccount).toBe(account)
      expect(context.user).toBe(user)
      expect(mockedCreateAccount).toHaveBeenCalledWith({
        newAccountInfo: { kratosUserId, phone },
        config: expect.any(Object),
        phoneMetadata: undefined,
      })
      // Attributable, but not a failure: no error line, no span exception.
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: lookupFailed, kratosUserId }),
        "orphaned kratos identity: carrier lookup failed, repairing without phone metadata",
      )
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ kratosUserId, accountId: account.id }),
        "orphaned kratos identity repaired",
      )
      expect(childLogger.error).not.toHaveBeenCalled()
      expect(mockedRecordException).not.toHaveBeenCalled()
    })

    it("answers NOT_AUTHENTICATED when the identity has no phone trait", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone: undefined })

      await expectNotAuthenticated(sessionPublicContext({ tokenPayload, ip }))

      expect(mockedCreateAccount).not.toHaveBeenCalled()
      expect(mockedRecordException).toHaveBeenCalledWith(
        expect.objectContaining({
          error: orphan,
          level: ErrorLevel.Critical,
          attributes: expect.objectContaining({ kratosUserId }),
        }),
      )
    })

    it("answers NOT_AUTHENTICATED when the identity cannot be loaded", async () => {
      const kratosDown = new UnknownKratosError("kratos down")
      getIdentity.mockResolvedValue(kratosDown)

      await expectNotAuthenticated(sessionPublicContext({ tokenPayload, ip }))

      expect(mockedCreateAccount).not.toHaveBeenCalled()
      expect(mockedRecordException).toHaveBeenCalledWith(
        expect.objectContaining({ error: kratosDown, level: ErrorLevel.Critical }),
      )
    })

    it("answers NOT_AUTHENTICATED when the repair write fails, and records it as Critical", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone })
      // A collision on users.phone: the account is still missing afterwards,
      // so this identity cannot be repaired by re-running registration.
      const collision = new DuplicateKeyForPersistError(
        "E11000 duplicate key error collection: galoy.users index: phone_1",
      )
      mockedCreateAccount.mockResolvedValue(collision)

      await expectNotAuthenticated(sessionPublicContext({ tokenPayload, ip }))

      expect(mockedRecordException).toHaveBeenCalledWith(
        expect.objectContaining({
          error: collision,
          level: ErrorLevel.Critical,
          attributes: expect.objectContaining({ kratosUserId }),
        }),
      )
      expect(childLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: collision, kratosUserId }),
        "orphaned kratos identity: repair failed",
      )
    })

    // An orphan opening the app fires several queries at once. accounts.
    // kratosUserId is unique, so without single-flighting every request but
    // one would lose the persistNew race and be answered NOT_AUTHENTICATED on
    // the very launch that fixed the account.
    it("single-flights concurrent requests: one repair, every request gets the account", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone })
      let releaseCreate: (value: Account) => void = () => undefined
      mockedCreateAccount.mockReturnValue(
        new Promise<Account>((resolve) => {
          releaseCreate = resolve
        }),
      )

      const first = sessionPublicContext({ tokenPayload, ip })
      const second = sessionPublicContext({ tokenPayload, ip })
      await flushMicrotasks()

      // Both requests are past the lookup and parked on the same repair. The
      // carrier lookup is a billed Twilio call, so it is single-flighted too.
      expect(mockedCreateAccount).toHaveBeenCalledTimes(1)
      expect(getIdentity).toHaveBeenCalledTimes(1)
      expect(getCarrier).toHaveBeenCalledTimes(1)

      releaseCreate(account)
      const [one, two] = await Promise.all([first, second])

      expect(one.domainAccount).toBe(account)
      expect(two.domainAccount).toBe(account)
      expect(mockedCreateAccount).toHaveBeenCalledTimes(1)
      expect(mockedRecordException).not.toHaveBeenCalled()
    })

    it("adopts the account a request on another replica wrote after losing the persistNew race", async () => {
      getIdentity.mockResolvedValue({ id: kratosUserId, phone })
      mockedCreateAccount.mockResolvedValue(
        new DuplicateKeyForPersistError(
          "E11000 duplicate key error collection: galoy.accounts index: kratosUserId_1",
        ),
      )
      mockedGetAccount.mockReset()
      mockedGetAccount.mockResolvedValueOnce(orphan).mockResolvedValueOnce(account)

      const context = await sessionPublicContext({ tokenPayload, ip })

      expect(context.domainAccount).toBe(account)
      expect(context.user).toBe(user)
      expect(mockedCreateAccount).toHaveBeenCalledTimes(1)
      expect(mockedGetAccount).toHaveBeenCalledTimes(2)
      expect(mockedRecordException).not.toHaveBeenCalled()
      expect(childLogger.error).not.toHaveBeenCalled()
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ kratosUserId, accountId: account.id }),
        "orphaned kratos identity repaired by a concurrent request",
      )
    })

    // An identity that cannot be repaired keeps making requests (the mobile
    // app's pollers do not stop on NOT_AUTHENTICATED). Each one must not cost
    // a Kratos admin read plus Mongo writes, nor page anyone again.
    it("does not retry a failed repair within the retry window, and warns rather than errors on the next failure", async () => {
      const start = new Date("2026-09-01T12:00:00Z").getTime()
      jest.useFakeTimers({ now: start })
      const kratosDown = new UnknownKratosError("kratos down")
      getIdentity.mockResolvedValue(kratosDown)

      await expectNotAuthenticated(sessionPublicContext({ tokenPayload, ip }))
      expect(getIdentity).toHaveBeenCalledTimes(1)
      expect(childLogger.error).toHaveBeenCalledTimes(1)
      expect(mockedRecordException).toHaveBeenCalledTimes(1)

      jest.setSystemTime(start + 30_000)
      await expectNotAuthenticated(sessionPublicContext({ tokenPayload, ip }))
      await expectNotAuthenticated(sessionPublicContext({ tokenPayload, ip }))

      // Still one Kratos round trip, one error line, one Critical span.
      expect(getIdentity).toHaveBeenCalledTimes(1)
      expect(childLogger.error).toHaveBeenCalledTimes(1)
      expect(mockedRecordException).toHaveBeenCalledTimes(1)
      expect(childLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ kratosUserId, repairFailures: 1 }),
        "orphaned kratos identity: repair skipped, last attempt failed recently",
      )

      jest.setSystemTime(start + 61_000)
      await expectNotAuthenticated(sessionPublicContext({ tokenPayload, ip }))

      // Window elapsed: one more attempt, reported at warn, not as Critical.
      expect(getIdentity).toHaveBeenCalledTimes(2)
      expect(childLogger.error).toHaveBeenCalledTimes(1)
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: kratosDown, kratosUserId, repairFailures: 2 }),
        "orphaned kratos identity: could not load identity",
      )
      expect(mockedRecordException).toHaveBeenCalledTimes(2)
      expect(mockedRecordException).toHaveBeenLastCalledWith(
        expect.objectContaining({ error: kratosDown, level: ErrorLevel.Warn }),
      )
    })

    it("retries after the window and forgets the failure once the repair succeeds", async () => {
      const start = new Date("2026-09-01T12:00:00Z").getTime()
      jest.useFakeTimers({ now: start })
      getIdentity.mockResolvedValueOnce(new UnknownKratosError("kratos down"))

      await expectNotAuthenticated(sessionPublicContext({ tokenPayload, ip }))

      jest.setSystemTime(start + 61_000)
      getIdentity.mockResolvedValue({ id: kratosUserId, phone })
      mockedCreateAccount.mockResolvedValue(account)

      const context = await sessionPublicContext({ tokenPayload, ip })

      expect(context.domainAccount).toBe(account)
      expect(mockedCreateAccount).toHaveBeenCalledTimes(1)
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ kratosUserId, accountId: account.id }),
        "orphaned kratos identity repaired",
      )
    })
  })
})
