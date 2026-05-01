/**
 * Unit tests for loginDeviceUpgradeWithPhone — device→phone upgrade collision handling.
 *
 * Verifies the two error paths when a phone number is already registered:
 * - Non-zero device balance → PhoneAccountAlreadyExistsNeedToSweepFundsError
 * - Zero device balance → PhoneAccountAlreadyExistsCannotUpgradeError
 */

import { USDAmount } from "@domain/shared"
import {
  loginDeviceUpgradeWithPhone,
} from "@app/authentication/login"
import {
  PhoneAccountAlreadyExistsCannotUpgradeError,
  PhoneAccountAlreadyExistsNeedToSweepFundsError,
} from "@services/kratos"

// Mock all external service boundaries to isolate the function under test
jest.mock("@services/rate-limit", () => ({
  consumeLimiter: jest.fn().mockResolvedValue(true),
  RedisRateLimitService: jest.fn(() => ({
    reward: jest.fn().mockResolvedValue(true),
  })),
}))

jest.mock("@services/twilio", () => ({
  isPhoneCodeValid: jest.fn().mockResolvedValue(true),
}))

jest.mock("@services/kratos", () => {
  const mockIdentityRepo = {
    getUserIdFromIdentifier: jest.fn().mockResolvedValue("existing-user-id"),
  }
  return {
    IdentityRepository: jest.fn(() => mockIdentityRepo),
    PhoneAccountAlreadyExistsCannotUpgradeError: jest.fn(),
    PhoneAccountAlreadyExistsNeedToSweepFundsError: jest.fn(),
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
  wrapAsyncFunctionsToRunInSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
  ErrorLevel: { Warn: "warn", Critical: "critical" },
}))

jest.mock("@config", () => {
  const actual = jest.requireActual("@config")
  return {
    ...actual,
    getTestAccounts: jest.fn(() => ({})),
  }
})

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
