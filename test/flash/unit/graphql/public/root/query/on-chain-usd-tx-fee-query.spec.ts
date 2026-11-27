const mockUsdWalletAmountFromWalletId = jest.fn()
jest.mock("@app/wallets", () => ({
  usdWalletAmountFromWalletId: (args: unknown) => mockUsdWalletAmountFromWalletId(args),
}))

const mockEstimateOnchainFee = jest.fn()
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    estimateOnchainFee: (...args: unknown[]) => mockEstimateOnchainFee(...args),
  },
}))

import { ErrorLevel } from "@domain/shared"
import { CouldNotFindWalletFromIdError } from "@domain/errors"
import { InputValidationError } from "@graphql/error"
import OnChainUsdTxFeeQuery from "@graphql/public/root/query/on-chain-usd-tx-fee-query"
import {
  IbexAmountBelowMinimum,
  IbexError,
  UnexpectedIbexResponse,
} from "@services/ibex/errors"

const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const address = "bc1qm59zrvx4hjfdr76vuety9xl4kdzn7l5fu65f3x" as OnChainAddress
const domainAccount = { id: "account-id" } as Account
const usdAmount = { marker: "the amount built for the wallet" }

const run = (
  overrides: Record<string, unknown> = {},
  context: unknown = { domainAccount },
) =>
  OnChainUsdTxFeeQuery.resolve?.(
    null,
    { walletId, address, amount: 2000, speed: "FAST", ...overrides } as never,
    context as GraphQLPublicContextAuth,
    {} as never,
  ) as Promise<{ amount: number } | Error>

describe("onChainUsdTxFee", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUsdWalletAmountFromWalletId.mockResolvedValue(usdAmount)
    // IBEX names the fee in dollars: 36 cents arrives as 0.36.
    mockEstimateOnchainFee.mockResolvedValue({ fee: 0.36, feeSat: 603 })
  })

  it("returns the IBEX fee in cents for the cents the caller asked about", async () => {
    expect(await run()).toEqual({ amount: 36 })

    expect(mockUsdWalletAmountFromWalletId).toHaveBeenCalledWith({
      walletId,
      amount: "2000",
    })
    expect(mockEstimateOnchainFee).toHaveBeenCalledWith(usdAmount, address)
  })

  it("does not hand IBEX's dollar figure to a field that is read as cents", async () => {
    mockEstimateOnchainFee.mockResolvedValueOnce({ fee: 0.360255943028, feeSat: 603 })

    const result = (await run()) as { amount: number }

    expect(result.amount).toBeCloseTo(36.0255943028, 6)
    expect(result.amount).not.toBeCloseTo(0.360255943028, 6)
  })

  it("passes a zero fee through as zero", async () => {
    mockEstimateOnchainFee.mockResolvedValueOnce({ fee: 0 })

    expect(await run()).toEqual({ amount: 0 })
  })

  it("answers with the wallet error, without asking IBEX", async () => {
    const failure = new CouldNotFindWalletFromIdError(walletId)
    mockUsdWalletAmountFromWalletId.mockResolvedValueOnce(failure)

    expect(await run()).toBe(failure)
    expect(mockEstimateOnchainFee).not.toHaveBeenCalled()
  })

  it("answers with the IBEX error when IBEX cannot estimate", async () => {
    const failure = new IbexError(new Error("503"))
    mockEstimateOnchainFee.mockResolvedValueOnce(failure)

    expect(await run()).toBe(failure)
  })

  it("names the minimum when IBEX refuses to estimate a small amount", async () => {
    const failure = new IbexAmountBelowMinimum(
      new Error("Bad Request"),
      ErrorLevel.Info,
      "minimum amount is 5500 Satoshi",
    )
    mockEstimateOnchainFee.mockResolvedValueOnce(failure)

    const result = await run({ amount: 300 })

    expect(result).toBe(failure)
    expect((result as Error).message).toBe(
      "This amount is below the minimum of 5,500 sats. Enter a larger amount.",
    )
  })

  it.each([
    ["no fee", {}],
    ["a fee that is not a number", { fee: "0.36" }],
  ])("answers with an unexpected-response error when IBEX sends %s", async (_, resp) => {
    mockEstimateOnchainFee.mockResolvedValueOnce(resp)

    expect(await run()).toBeInstanceOf(UnexpectedIbexResponse)
  })

  it.each(["walletId", "address", "amount", "speed"])(
    "throws the validation error for a bad %s before any lookup",
    async (field) => {
      const bad = new InputValidationError({ message: `bad ${field}` })

      await expect(run({ [field]: bad })).rejects.toBe(bad)
      expect(mockUsdWalletAmountFromWalletId).not.toHaveBeenCalled()
    },
  )

  it("requires a logged-in account", async () => {
    await expect(run({}, {})).rejects.toThrow("Authentication required")
    expect(mockUsdWalletAmountFromWalletId).not.toHaveBeenCalled()
  })
})
