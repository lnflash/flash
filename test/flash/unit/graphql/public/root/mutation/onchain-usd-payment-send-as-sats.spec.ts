const calls: string[] = []

const mockAuthorizeSend = jest.fn()
jest.mock("@app/payments/authorize-send", () => ({
  authorizeSend: async (args: unknown) => {
    calls.push("authorizeSend")
    const result = await mockAuthorizeSend(args)
    return result === undefined ? true : result
  },
}))

const mockUsdCentsToDeliverSats = jest.fn()
jest.mock("@app/payments/usd-cents-for-sats", () => ({
  usdCentsToDeliverSats: async (sats: number) => {
    calls.push("usdCentsToDeliverSats")
    return mockUsdCentsToDeliverSats(sats)
  },
}))

const mockPayOnChainByWalletId = jest.fn()
jest.mock("@app/index", () => ({
  Wallets: {
    payOnChainByWalletId: async (args: unknown) => {
      calls.push("payOnChainByWalletId")
      return mockPayOnChainByWalletId(args)
    },
  },
}))

const mockUsdWalletAmountFromWalletId = jest.fn()
jest.mock("@app/wallets", () => ({
  usdWalletAmountFromWalletId: (args: unknown) => mockUsdWalletAmountFromWalletId(args),
}))

const mockResolveCashWalletMutationWalletIdForAccount = jest.fn()
jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletMutationWalletIdForAccount: (args: unknown) =>
    mockResolveCashWalletMutationWalletIdForAccount(args),
}))

import { PriceNotAvailableError } from "@domain/price"
import { InvalidSendAmountError } from "@domain/payments/errors"
import {
  CouldNotFindWalletFromIdError,
  WithdrawalLimitsExceededError,
} from "@domain/errors"
import { InputValidationError } from "@graphql/error"
import { ErrorLevel } from "@domain/shared"
import { IbexAmountBelowMinimum } from "@services/ibex/errors"
import OnChainUsdPaymentSendAsBtcDenominatedMutation from "@graphql/public/root/mutation/onchain-usd-payment-send-as-sats"

type MutationResult = { status?: string; errors: { message: string }[] }

const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const routedWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const address = "bc1qm59zrvx4hjfdr76vuety9xl4kdzn7l5fu65f3x" as OnChainAddress
const domainAccount = { id: "account-id" } as Account
const client = { cashWalletPresentation: "usdt", hasUsdtCashWalletSupport: true } as const
const usdAmount = { marker: "the amount built for the routed wallet" }

const input = (overrides: Record<string, unknown> = {}) => ({
  walletId,
  address,
  amount: 6_000,
  speed: "FAST",
  memo: "lunch",
  ...overrides,
})

const run = (overrides: Record<string, unknown> = {}, context: unknown = undefined) =>
  OnChainUsdPaymentSendAsBtcDenominatedMutation.resolve?.(
    null,
    { input: input(overrides) } as never,
    (context ?? {
      domainAccount,
      cashWalletClientCapabilities: client,
    }) as GraphQLPublicContextAuth,
    {} as never,
  ) as Promise<MutationResult>

describe("onChainUsdPaymentSendAsBtcDenominated", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    calls.length = 0
    mockResolveCashWalletMutationWalletIdForAccount.mockResolvedValue(routedWalletId)
    mockUsdCentsToDeliverSats.mockResolvedValue({ cents: 362, marginBps: 50 })
    mockUsdWalletAmountFromWalletId.mockResolvedValue(usdAmount)
    mockPayOnChainByWalletId.mockResolvedValue({ status: { value: "success" } })
  })

  it("sends the marked-up dollar amount for the sats, from the routed Cash wallet", async () => {
    const result = await run()

    expect(result).toEqual({ status: "success", errors: [] })
    expect(mockResolveCashWalletMutationWalletIdForAccount).toHaveBeenCalledWith({
      account: domainAccount,
      walletId,
      client,
    })
    expect(mockUsdCentsToDeliverSats).toHaveBeenCalledWith(6_000)
    expect(mockUsdWalletAmountFromWalletId).toHaveBeenCalledWith({
      walletId: routedWalletId,
      amount: "362",
    })
    expect(mockPayOnChainByWalletId).toHaveBeenCalledWith({
      senderAccount: domainAccount,
      senderWalletId: routedWalletId,
      amount: usdAmount,
      address,
      speed: "FAST",
      memo: "lunch",
    })
  })

  it("no longer answers that bitcoin denomination is unsupported", async () => {
    const result = await run()

    expect(result).not.toBeInstanceOf(Error)
    expect(JSON.stringify(result)).not.toMatch(/do not support Bitcoin denomination/)
  })

  it("runs the send guard first, on the sat amount the caller asked for", async () => {
    await run()

    expect(mockAuthorizeSend).toHaveBeenCalledWith({
      senderAccount: domainAccount,
      senderWalletId: routedWalletId,
      amount: { currency: "BTC", sats: 6_000 },
      kind: "onchain",
    })
    expect(calls).toEqual([
      "authorizeSend",
      "usdCentsToDeliverSats",
      "payOnChainByWalletId",
    ])
  })

  it("stops at a guard rejection: no price read, no payout", async () => {
    const rejection = new WithdrawalLimitsExceededError("over the daily limit")
    mockAuthorizeSend.mockResolvedValueOnce(rejection)

    const result = await run()

    expect(result.status).toBe("failed")
    expect(result.errors).toHaveLength(1)
    expect(mockUsdCentsToDeliverSats).not.toHaveBeenCalled()
    expect(mockPayOnChainByWalletId).not.toHaveBeenCalled()
  })

  it("leaves a zero sat amount to the guard, which refuses and counts it", async () => {
    mockAuthorizeSend.mockResolvedValueOnce(
      new InvalidSendAmountError("Amount must be greater than zero"),
    )

    const result = await run({ amount: 0 })

    expect(mockAuthorizeSend).toHaveBeenCalledWith(
      expect.objectContaining({ amount: { currency: "BTC", sats: 0 } }),
    )
    expect(result.status).toBe("failed")
    expect(mockPayOnChainByWalletId).not.toHaveBeenCalled()
  })

  it("fails without paying when there is no price to convert at", async () => {
    mockUsdCentsToDeliverSats.mockResolvedValueOnce(new PriceNotAvailableError())

    const result = await run()

    expect(result.status).toBe("failed")
    expect(mockUsdWalletAmountFromWalletId).not.toHaveBeenCalled()
    expect(mockPayOnChainByWalletId).not.toHaveBeenCalled()
  })

  it("fails before the guard when the Cash wallet cannot be resolved", async () => {
    mockResolveCashWalletMutationWalletIdForAccount.mockResolvedValueOnce(
      new CouldNotFindWalletFromIdError(walletId),
    )

    const result = await run()

    expect(result.status).toBe("failed")
    expect(mockAuthorizeSend).not.toHaveBeenCalled()
    expect(mockPayOnChainByWalletId).not.toHaveBeenCalled()
  })

  it("fails without paying when the wallet amount cannot be built", async () => {
    mockUsdWalletAmountFromWalletId.mockResolvedValueOnce(
      new CouldNotFindWalletFromIdError(routedWalletId),
    )

    const result = await run()

    expect(result.status).toBe("failed")
    expect(mockPayOnChainByWalletId).not.toHaveBeenCalled()
  })

  it("reports a payout failure as a failed payment", async () => {
    mockPayOnChainByWalletId.mockResolvedValueOnce(
      new WithdrawalLimitsExceededError("refused downstream"),
    )

    const result = await run()

    expect(result.status).toBe("failed")
    expect(result.errors).toHaveLength(1)
  })

  it("tells the payer the minimum when IBEX refuses a small amount", async () => {
    mockPayOnChainByWalletId.mockResolvedValueOnce(
      new IbexAmountBelowMinimum(
        new Error("Bad Request"),
        ErrorLevel.Info,
        "minimum amount is 5500 Satoshi",
      ),
    )

    const result = await run({ amount: 5_000 })

    expect(result.status).toBe("failed")
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: "This amount is below the minimum of 5,500 sats. Enter a larger amount.",
        code: "INVALID_INPUT",
      }),
    ])
  })

  it("passes a pending payout through as pending", async () => {
    mockPayOnChainByWalletId.mockResolvedValueOnce({ status: { value: "pending" } })

    expect(await run()).toEqual({ status: "pending", errors: [] })
  })

  it.each(["walletId", "address", "amount", "memo", "speed"])(
    "returns the validation message for a bad %s and touches nothing",
    async (field) => {
      const result = await run({
        [field]: new InputValidationError({ message: `bad ${field}` }),
      })

      expect(result.errors).toEqual([{ message: `bad ${field}` }])
      expect(mockResolveCashWalletMutationWalletIdForAccount).not.toHaveBeenCalled()
      expect(mockAuthorizeSend).not.toHaveBeenCalled()
      expect(mockPayOnChainByWalletId).not.toHaveBeenCalled()
    },
  )

  it("requires a logged-in account", async () => {
    await expect(run({}, { cashWalletClientCapabilities: client })).rejects.toThrow(
      "Authentication required",
    )
    expect(mockPayOnChainByWalletId).not.toHaveBeenCalled()
  })
})
