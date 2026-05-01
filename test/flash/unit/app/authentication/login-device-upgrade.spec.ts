/* eslint-disable @typescript-eslint/no-explicit-any */

import { USDAmount } from "@domain/shared"
import {
  PhoneAccountAlreadyExistsCannotUpgradeError,
  PhoneAccountAlreadyExistsNeedToSweepFundsError,
} from "@services/kratos"
import { loginDeviceUpgradeWithPhone } from "@app/authentication/login"

jest.mock("@app/accounts/create-account", () => ({
  createAccountForDeviceAccount: jest.fn(),
}))

jest.mock("@services/ledger", () => ({
  LedgerService: jest.fn(),
}))

jest.mock("@app/accounts", () => ({
  upgradeAccountFromDeviceToPhone: jest.fn(),
}))

jest.mock("@services/twilio", () => ({
  isPhoneCodeValid: jest.fn().mockResolvedValue(true),
  TwilioClient: jest.fn(),
}))

jest.mock("@services/kratos", () => {
  const actual = jest.requireActual("@services/kratos")
  const mockIdentityRepo = {
    getUserIdFromIdentifier: jest.fn().mockResolvedValue("existing-user-id"),
  }

  return {
    ...actual,
    IdentityRepository: jest.fn(() => mockIdentityRepo),
    AuthWithEmailPasswordlessService: jest.fn(),
    AuthWithPhonePasswordlessService: jest.fn(),
    AuthWithUsernamePasswordDeviceIdService: jest.fn(),
  }
})

jest.mock("@services/mongoose", () => ({
  WalletsRepository: jest.fn(),
}))

jest.mock("@app/wallets", () => ({
  getBalanceForWallet: jest.fn(),
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@domain/accounts-ips/ip-metadata-authorizer", () => ({
  IPMetadataAuthorizer: jest.fn(),
}))

jest.mock("@services/ipfetcher", () => ({
  IpFetcher: jest.fn(),
}))

jest.mock("@app/authentication/ratelimits", () => ({
  checkFailedLoginAttemptPerIpLimits: jest.fn().mockResolvedValue(true),
  checkFailedLoginAttemptPerLoginIdentifierLimits: jest.fn().mockResolvedValue(true),
  rewardFailedLoginAttemptPerIpLimits: jest.fn().mockResolvedValue(true),
  rewardFailedLoginAttemptPerLoginIdentifierLimits: jest.fn().mockResolvedValue(true),
}))

jest.mock("@config", () => ({
  getAccountsOnboardConfig: jest.fn(() => ({ requireCountry: false })),
}))

const mockWalletsRepo = (): { listByAccountId: jest.Mock } => ({
  listByAccountId: jest.fn().mockResolvedValue([]),
})

describe("loginDeviceUpgradeWithPhone", () => {
  const mockAccount = { id: "account-id" } as any
  const mockPhone = "+15551234567" as any
  const mockCode = "123456" as any
  const mockIp = "127.0.0.1" as any

  beforeEach(() => {
    jest.clearAllMocks()
    ;(require("@services/mongoose").WalletsRepository as jest.Mock).mockReturnValue(
      mockWalletsRepo(),
    )
    ;(require("@services/kratos").IdentityRepository as jest.Mock).mockReturnValue({
      getUserIdFromIdentifier: jest.fn().mockResolvedValue("existing-user-id"),
    })
  })

  it("returns NeedToSweepFunds when device account has balance", async () => {
    const { WalletsRepository } = require("@services/mongoose")
    const wallet = { id: "wallet-id" }
    WalletsRepository().listByAccountId.mockResolvedValue([wallet])

    const { getBalanceForWallet } = require("@app/wallets")
    getBalanceForWallet.mockResolvedValue(USDAmount.cents(5000n))

    const result = await loginDeviceUpgradeWithPhone({
      account: mockAccount,
      phone: mockPhone,
      code: mockCode,
      ip: mockIp,
    })

    expect(result).toBeInstanceOf(PhoneAccountAlreadyExistsNeedToSweepFundsError)
    expect(getBalanceForWallet).toHaveBeenCalledWith({ walletId: "wallet-id" })
  })

  it("returns CannotUpgrade when device account has zero balance", async () => {
    const { WalletsRepository } = require("@services/mongoose")
    const wallet = { id: "wallet-id" }
    WalletsRepository().listByAccountId.mockResolvedValue([wallet])

    const { getBalanceForWallet } = require("@app/wallets")
    getBalanceForWallet.mockResolvedValue(USDAmount.ZERO)

    const result = await loginDeviceUpgradeWithPhone({
      account: mockAccount,
      phone: mockPhone,
      code: mockCode,
      ip: mockIp,
    })

    expect(result).toBeInstanceOf(PhoneAccountAlreadyExistsCannotUpgradeError)
    expect(getBalanceForWallet).toHaveBeenCalledWith({ walletId: "wallet-id" })
  })

  it("returns NeedToSweepFunds when any wallet has balance among multiple", async () => {
    const { WalletsRepository } = require("@services/mongoose")
    const wallet0 = { id: "wallet-0" }
    const wallet1 = { id: "wallet-1" }
    WalletsRepository().listByAccountId.mockResolvedValue([wallet0, wallet1])

    const { getBalanceForWallet } = require("@app/wallets")
    getBalanceForWallet
      .mockResolvedValueOnce(USDAmount.ZERO)
      .mockResolvedValueOnce(USDAmount.cents(100n))

    const result = await loginDeviceUpgradeWithPhone({
      account: mockAccount,
      phone: mockPhone,
      code: mockCode,
      ip: mockIp,
    })

    expect(result).toBeInstanceOf(PhoneAccountAlreadyExistsNeedToSweepFundsError)
  })
})
