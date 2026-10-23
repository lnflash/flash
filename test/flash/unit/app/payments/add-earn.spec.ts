import { addEarn } from "@app/payments/add-earn"
import { intraledgerPaymentSendWalletIdForBtcWallet } from "@app/payments/send-intraledger"
import { usdWalletAmountFromInput } from "@app/wallets/usd-wallet-amount"
import { AccountStatus } from "@domain/accounts"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import {
  InactiveAccountError,
  InvalidQuizQuestionIdError,
  InvalidWalletId,
  MismatchedCurrencyForWalletError,
  NoBtcWalletExistsForAccountError,
  OperationInterruptedError,
  RewardAlreadyPresentError,
  UnknownRepositoryError,
  UnsupportedCurrencyError,
} from "@domain/errors"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { getFunderWalletId } from "@services/ledger/caching"
import {
  AccountsRepository,
  RewardsRepository,
  UsersRepository,
  WalletsRepository,
} from "@services/mongoose"

jest.mock("@config", () => ({
  getRewardsConfig: () => ({
    phoneMetadataValidationSettings: {},
    ipMetadataValidationSettings: {},
  }),
  OnboardingEarn: { whatIsBitcoin: 1 },
}))
jest.mock("@domain/accounts-ips/ip-metadata-authorizer", () => ({
  IPMetadataAuthorizer: () => ({ authorize: () => true }),
}))
jest.mock("@domain/users", () => ({
  PhoneMetadataAuthorizer: () => ({ authorize: () => true }),
}))
jest.mock("@services/ledger/caching", () => ({ getFunderWalletId: jest.fn() }))
jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(),
  RewardsRepository: jest.fn(),
  UsersRepository: jest.fn(),
  WalletsRepository: jest.fn(),
}))
jest.mock("@services/mongoose/accounts-ips", () => ({
  AccountsIpsRepository: () => ({ findLastByAccountId: async () => ({ metadata: {} }) }),
}))
jest.mock("@app/payments/send-intraledger", () => ({
  intraledgerPaymentSendWalletIdForBtcWallet: jest.fn(),
}))
jest.mock("@app/wallets/usd-wallet-amount", () => ({
  usdWalletAmountFromInput: jest.fn(),
}))

describe("addEarn preclaim safety", () => {
  const request = { accountId: "recipient" as AccountId, quizQuestionId: "whatIsBitcoin" }
  const claim = jest.fn()
  const findWallet = jest.fn()
  const listWallets = jest.fn()
  const findAccount = jest.fn()
  const funder = {
    id: "funder-wallet",
    accountId: "funder",
    type: WalletType.Checking,
    currency: WalletCurrency.Btc,
  }
  const recipient = {
    id: "recipient-wallet",
    accountId: "recipient",
    type: WalletType.Checking,
    currency: WalletCurrency.Btc,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    jest
      .mocked(getFunderWalletId)
      .mockReset()
      .mockResolvedValue("funder-wallet" as WalletId)
    findWallet.mockReset().mockResolvedValue(funder)
    listWallets.mockReset().mockResolvedValue([recipient])
    findAccount.mockReset().mockImplementation(async (id) => ({
      id,
      status: AccountStatus.Active,
      kratosUserId: "user",
    }))
    claim.mockReset().mockResolvedValue(true)
    jest
      .mocked(WalletsRepository)
      .mockReturnValue({ findById: findWallet, listByAccountId: listWallets } as never)
    jest.mocked(AccountsRepository).mockReturnValue({ findById: findAccount } as never)
    jest.mocked(RewardsRepository).mockReturnValue({ add: claim })
    jest
      .mocked(UsersRepository)
      .mockReturnValue({ findById: async () => ({ phoneMetadata: {} }) } as never)
    jest
      .mocked(intraledgerPaymentSendWalletIdForBtcWallet)
      .mockReset()
      .mockResolvedValue(PaymentSendStatus.Success)
    // Exercise the REAL current adapter by default: BTC is unsupported.
    jest
      .mocked(usdWalletAmountFromInput)
      .mockReset()
      .mockImplementation(
        jest.requireActual("@app/wallets/usd-wallet-amount").usdWalletAmountFromInput,
      )
  })

  const expectNoClaimOrSend = () => {
    expect(claim).not.toHaveBeenCalled()
    expect(intraledgerPaymentSendWalletIdForBtcWallet).not.toHaveBeenCalled()
  }

  it("keeps an otherwise eligible lesson unclaimed when the BTC adapter is unsupported", async () => {
    expect(await addEarn(request)).toBeInstanceOf(UnsupportedCurrencyError)
    expect(usdWalletAmountFromInput).toHaveBeenCalledWith("1", WalletCurrency.Btc)
    expectNoClaimOrSend()
  })

  it.each(["toString", "__proto__", "unknown"])(
    "rejects unconfigured lesson %s before looking up funding",
    async (quizQuestionId) => {
      expect(await addEarn({ ...request, quizQuestionId })).toBeInstanceOf(
        InvalidQuizQuestionIdError,
      )
      expect(getFunderWalletId).not.toHaveBeenCalled()
      expectNoClaimOrSend()
    },
  )

  it("handles an unconfigured funding resolver before claiming", async () => {
    jest.mocked(getFunderWalletId).mockRejectedValueOnce("Invalid funderWalletPath")
    expect(await addEarn(request)).toBeInstanceOf(UnknownRepositoryError)
    expect(findWallet).not.toHaveBeenCalled()
    expectNoClaimOrSend()
  })

  it("preserves a missing funding wallet error before claiming", async () => {
    const missing = new UnknownRepositoryError("wallet unavailable")
    findWallet.mockResolvedValueOnce(missing)
    expect(await addEarn(request)).toBe(missing)
    expectNoClaimOrSend()
  })

  it.each([WalletCurrency.Usd, WalletCurrency.Usdt])(
    "rejects a %s funder rather than treating reward sats as cents",
    async (currency) => {
      findWallet.mockResolvedValueOnce({ ...funder, currency })
      expect(await addEarn(request)).toBeInstanceOf(MismatchedCurrencyForWalletError)
      expectNoClaimOrSend()
    },
  )

  it("rejects an external SDK funding ID", async () => {
    findWallet.mockResolvedValueOnce({ ...funder, type: WalletType.External })
    expect(await addEarn(request)).toBeInstanceOf(InvalidWalletId)
    expectNoClaimOrSend()
  })

  it.each([
    [],
    [{ ...recipient, type: WalletType.External }],
    [{ ...recipient, currency: WalletCurrency.Usdt }],
  ])(
    "requires a checking BTC recipient, preserving eligibility for %j",
    async (...wallets) => {
      // Jest expands each array case into arguments.
      listWallets.mockResolvedValueOnce(wallets)
      expect(await addEarn(request)).toBeInstanceOf(NoBtcWalletExistsForAccountError)
      expectNoClaimOrSend()
    },
  )

  it("rejects a recipient wallet belonging to another account", async () => {
    listWallets.mockResolvedValueOnce([{ ...recipient, accountId: "other" }])
    expect(await addEarn(request)).toBeInstanceOf(InvalidWalletId)
    expectNoClaimOrSend()
  })

  it("does not let an external SDK wallet shadow a valid checking BTC recipient", async () => {
    listWallets.mockResolvedValueOnce([
      { ...recipient, id: "sdk-local-id", type: WalletType.External },
      recipient,
    ])
    expect(await addEarn(request)).toBeInstanceOf(UnsupportedCurrencyError)
    expectNoClaimOrSend()
  })

  it("rejects a funding wallet belonging to another account", async () => {
    findAccount.mockResolvedValueOnce({ id: "other", status: AccountStatus.Active })
    expect(await addEarn(request)).toBeInstanceOf(InvalidWalletId)
    expectNoClaimOrSend()
  })

  it.each(["funder", "recipient"])(
    "rejects an inactive %s before claiming",
    async (inactiveId) => {
      findAccount.mockImplementation(async (id) => ({
        id,
        status: id === inactiveId ? AccountStatus.Locked : AccountStatus.Active,
      }))
      expect(await addEarn(request)).toBeInstanceOf(InactiveAccountError)
      expectNoClaimOrSend()
    },
  )

  // Model a future supported adapter explicitly, without enabling a production
  // payout rail. Claim and settlement handling must remain fail-closed then.
  const permitFutureAdapter = () =>
    jest.mocked(usdWalletAmountFromInput).mockReturnValue({} as never)

  it("never sends after a duplicate claim", async () => {
    permitFutureAdapter()
    const duplicate = new RewardAlreadyPresentError()
    claim.mockResolvedValueOnce(duplicate)
    expect(await addEarn(request)).toBe(duplicate)
    expect(intraledgerPaymentSendWalletIdForBtcWallet).not.toHaveBeenCalled()
  })

  it.each([
    PaymentSendStatus.Pending,
    PaymentSendStatus.Failure,
    PaymentSendStatus.AlreadyPaid,
  ])("does not acknowledge an unconfirmed future payment %j as paid", async (status) => {
    permitFutureAdapter()
    jest.mocked(intraledgerPaymentSendWalletIdForBtcWallet).mockResolvedValueOnce(status)
    expect(await addEarn(request)).toBeInstanceOf(OperationInterruptedError)
    expect(claim).toHaveBeenCalledTimes(1)
  })

  it("preserves a future payment error without claiming settlement", async () => {
    permitFutureAdapter()
    const failure = new UnknownRepositoryError("provider unavailable")
    jest.mocked(intraledgerPaymentSendWalletIdForBtcWallet).mockResolvedValueOnce(failure)
    expect(await addEarn(request)).toBe(failure)
  })

  it("acknowledges only confirmed success from a future supported rail", async () => {
    permitFutureAdapter()
    jest
      .mocked(intraledgerPaymentSendWalletIdForBtcWallet)
      .mockResolvedValueOnce({ ...PaymentSendStatus.Success })
    expect(await addEarn(request)).toEqual({ id: request.quizQuestionId, earnAmount: 1 })
  })
})
