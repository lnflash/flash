const mockUsdCentsToDeliverSats = jest.fn()
jest.mock("@app/payments/usd-cents-for-sats", () => ({
  usdCentsToDeliverSats: (sats: number) => mockUsdCentsToDeliverSats(sats),
}))

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

import { PriceNotAvailableError } from "@domain/price"
import { CouldNotFindWalletFromIdError } from "@domain/errors"
import { InputValidationError } from "@graphql/error"
import OnChainUsdTxFeeAsBtcDenominatedQuery from "@graphql/public/root/query/on-chain-usd-tx-fee-query-as-sats"
import { ErrorLevel } from "@domain/shared"
import { IbexAmountBelowMinimum, IbexError } from "@services/ibex/errors"

const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const address = "bc1qm59zrvx4hjfdr76vuety9xl4kdzn7l5fu65f3x" as OnChainAddress
const domainAccount = { id: "account-id" } as Account
const usdAmount = { marker: "the amount built for the wallet" }

const run = (
  overrides: Record<string, unknown> = {},
  context: unknown = { domainAccount },
) =>
  OnChainUsdTxFeeAsBtcDenominatedQuery.resolve?.(
    null,
    { walletId, address, amount: 6_000, speed: "FAST", ...overrides } as never,
    context as GraphQLPublicContextAuth,
    {} as never,
  ) as Promise<{ amount: number }>

describe("onChainUsdTxFeeAsBtcDenominated", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUsdCentsToDeliverSats.mockResolvedValue({ cents: 362, marginBps: 50 })
    mockUsdWalletAmountFromWalletId.mockResolvedValue(usdAmount)
    // IBEX names the fee in dollars: 41 cents arrives as 0.41.
    mockEstimateOnchainFee.mockResolvedValue({ fee: 0.41, feeSat: 686 })
  })

  it("returns the IBEX fee, in cents, for the dollar amount the send will use", async () => {
    expect(await run()).toEqual({ amount: 41 })

    expect(mockUsdCentsToDeliverSats).toHaveBeenCalledWith(6_000)
    expect(mockUsdWalletAmountFromWalletId).toHaveBeenCalledWith({
      walletId,
      amount: "362",
    })
    expect(mockEstimateOnchainFee).toHaveBeenCalledWith(usdAmount, address)
  })

  it("fails when there is no price, without asking IBEX", async () => {
    mockUsdCentsToDeliverSats.mockResolvedValueOnce(new PriceNotAvailableError())

    await expect(run()).rejects.toBeInstanceOf(Error)
    expect(mockEstimateOnchainFee).not.toHaveBeenCalled()
  })

  it("fails when the wallet amount cannot be built, without asking IBEX", async () => {
    mockUsdWalletAmountFromWalletId.mockResolvedValueOnce(
      new CouldNotFindWalletFromIdError(walletId),
    )

    await expect(run()).rejects.toBeInstanceOf(Error)
    expect(mockEstimateOnchainFee).not.toHaveBeenCalled()
  })

  it("fails when IBEX cannot estimate", async () => {
    mockEstimateOnchainFee.mockResolvedValueOnce(new IbexError(new Error("503")))

    await expect(run()).rejects.toBeInstanceOf(Error)
  })

  it("names the minimum when IBEX refuses to estimate a small amount", async () => {
    mockEstimateOnchainFee.mockResolvedValueOnce(
      new IbexAmountBelowMinimum(
        new Error("Bad Request"),
        ErrorLevel.Info,
        "minimum amount is 5500 Satoshi",
      ),
    )

    await expect(run({ amount: 5_000 })).rejects.toMatchObject({
      message: "This amount is below the minimum of 5,500 sats. Enter a larger amount.",
      extensions: { code: "INVALID_INPUT" },
    })
  })

  it("does not hand IBEX's dollar figure to a field that is read as cents", async () => {
    mockEstimateOnchainFee.mockResolvedValueOnce({ fee: 0.409916881285, feeSat: 686 })

    const { amount } = await run()

    expect(amount).toBeCloseTo(40.9916881285, 6)
    expect(amount).not.toBeCloseTo(0.409916881285, 6)
  })

  it("fails when IBEX answers with a fee that is not a number", async () => {
    mockEstimateOnchainFee.mockResolvedValueOnce({ fee: "0.41" })

    await expect(run()).rejects.toBeInstanceOf(Error)
  })

  it("fails when IBEX answers without a fee", async () => {
    mockEstimateOnchainFee.mockResolvedValueOnce({})

    await expect(run()).rejects.toBeInstanceOf(Error)
  })

  it("passes a zero fee through as zero, not as a missing fee", async () => {
    mockEstimateOnchainFee.mockResolvedValueOnce({ fee: 0 })

    expect(await run()).toEqual({ amount: 0 })
  })

  it.each(["walletId", "address", "amount", "speed"])(
    "throws the validation error for a bad %s before any lookup",
    async (field) => {
      const bad = new InputValidationError({ message: `bad ${field}` })

      await expect(run({ [field]: bad })).rejects.toBe(bad)
      expect(mockUsdCentsToDeliverSats).not.toHaveBeenCalled()
    },
  )

  it("requires a logged-in account", async () => {
    await expect(run({}, {})).rejects.toThrow("Authentication required")
    expect(mockUsdCentsToDeliverSats).not.toHaveBeenCalled()
  })
})
