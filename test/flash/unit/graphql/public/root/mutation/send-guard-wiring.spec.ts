// ENG-573 send guard wiring for the send mutations that have no resolver spec
// of their own: the no-amount BTC invoice send and both on-chain USD sends.
// Each case proves the guard runs with the right amount/kind and that a
// rejection returns a failed payload before anything downstream is touched.

const mockAuthorizeSend = jest.fn()
jest.mock("@app/payments/authorize-send", () => ({
  authorizeSend: async (args: unknown) => {
    const result = await mockAuthorizeSend(args)
    return result === undefined ? true : result
  },
}))

const mockPayNoAmountInvoiceByWalletIdForBtcWallet = jest.fn()
const mockPayOnChainByWalletId = jest.fn()
jest.mock("@app", () => ({
  Payments: {
    payNoAmountInvoiceByWalletIdForBtcWallet: (args: unknown) =>
      mockPayNoAmountInvoiceByWalletIdForBtcWallet(args),
  },
  Wallets: {
    payOnChainByWalletId: (args: unknown) => mockPayOnChainByWalletId(args),
  },
}))

const mockUsdWalletAmountFromWalletId = jest.fn()
const mockGetBalanceForWallet = jest.fn()
jest.mock("@app/wallets", () => ({
  usdWalletAmountFromWalletId: (args: unknown) => mockUsdWalletAmountFromWalletId(args),
  getBalanceForWallet: (args: unknown) => mockGetBalanceForWallet(args),
}))

const mockResolveCashWalletMutationWalletIdForAccount = jest.fn()
jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletMutationWalletIdForAccount: (args: unknown) =>
    mockResolveCashWalletMutationWalletIdForAccount(args),
}))

import { SEND_GUARD_NOT_APPLICABLE } from "@app/payments/send-guard-optout"
import { WithdrawalLimitsExceededError } from "@domain/errors"
import { USDAmount } from "@domain/shared"
import LnNoAmountInvoicePaymentSendMutation from "@graphql/public/root/mutation/ln-noamount-invoice-payment-send"
import OnChainPaymentSendAllMutation from "@graphql/public/root/mutation/onchain-payment-send-all"
import OnChainUsdPaymentSendMutation from "@graphql/public/root/mutation/onchain-usd-payment-send"

type MutationResult = { status?: string; errors: { message: string }[] }

const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const routedWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const domainAccount = { id: "account-id" } as Account
const client = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
} as const
const context = {
  domainAccount,
  cashWalletClientCapabilities: client,
} as GraphQLPublicContextAuth

const rejection = new WithdrawalLimitsExceededError(
  "Cannot transfer more than $125.00 in 24 hours",
)

type Resolver = (
  source: null,
  args: { input: Record<string, unknown> },
  ctx: GraphQLPublicContextAuth,
  info: never,
) => Promise<MutationResult>

const run = (mutation: unknown, input: Record<string, unknown>) =>
  (mutation as { resolve: Resolver }).resolve(null, { input }, context, {} as never)

describe("ENG-573 send guard wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveCashWalletMutationWalletIdForAccount.mockResolvedValue(routedWalletId)
    // Mirror the real send function's contract: it hands `authorize` to
    // withPaymentIdempotency, which runs it only on the path that will pay and
    // short-circuits on a rejection.
    mockPayNoAmountInvoiceByWalletIdForBtcWallet.mockImplementation(
      async ({ authorize }: { authorize?: () => Promise<unknown> }) => {
        const authorized = await authorize?.()
        return authorized instanceof Error ? authorized : { value: "success" }
      },
    )
    mockPayOnChainByWalletId.mockResolvedValue({ status: { value: "success" } })
    mockUsdWalletAmountFromWalletId.mockResolvedValue(USDAmount.cents("700"))
    mockGetBalanceForWallet.mockResolvedValue(USDAmount.cents("12345"))
  })

  describe("lnNoAmountInvoicePaymentSend (BTC sats)", () => {
    const input = {
      walletId,
      paymentRequest: "lnbc1noamount",
      amount: 700,
      memo: null,
      idempotencyKey: null,
    }

    // ENG-573 round 2: the guard is handed DOWN as the idempotency wrapper's
    // `authorize` hook (withPaymentIdempotency lives inside
    // payNoAmountInvoiceByWalletIdForBtcWallet), not awaited ahead of it. Ahead
    // of the wrapper, every retry of a timed-out send burned a burst point
    // before reaching the replay and was re-priced against a moved mid price.
    it("hands the guard down to the app layer instead of running it first", async () => {
      const result = await run(LnNoAmountInvoicePaymentSendMutation, input)

      expect(mockPayNoAmountInvoiceByWalletIdForBtcWallet).toHaveBeenCalledTimes(1)
      const { authorize } = mockPayNoAmountInvoiceByWalletIdForBtcWallet.mock.calls[0][0]
      expect(typeof authorize).toBe("function")

      expect(mockAuthorizeSend).toHaveBeenCalledWith({
        senderAccount: domainAccount,
        senderWalletId: walletId,
        amount: { currency: "BTC", sats: 700 },
        kind: "lightning",
      })
      expect(result).toEqual({ errors: [], status: "success" })
    })

    it("does not consult the guard when the wrapper never runs the hook (a replay)", async () => {
      mockPayNoAmountInvoiceByWalletIdForBtcWallet.mockResolvedValueOnce({
        value: "success",
      })

      const result = await run(LnNoAmountInvoicePaymentSendMutation, input)

      expect(result).toEqual({ errors: [], status: "success" })
      expect(mockAuthorizeSend).not.toHaveBeenCalled()
    })

    it("returns a failed payload carrying the guard's error when the hook rejects", async () => {
      mockAuthorizeSend.mockResolvedValueOnce(rejection)

      const result = await run(LnNoAmountInvoicePaymentSendMutation, input)

      expect(result.status).toBe("failed")
      expect(result.errors[0]).toMatchObject({ message: rejection.message })
    })
  })

  describe("onChainUsdPaymentSend (USD cents)", () => {
    const input = {
      walletId,
      address: "bc1qexampleaddress",
      amount: 700,
      memo: null,
      speed: "FAST",
    }

    it("authorises the cent amount against the routed wallet as an onchain send, then pays", async () => {
      const result = await run(OnChainUsdPaymentSendMutation, input)

      expect(mockAuthorizeSend).toHaveBeenCalledWith({
        senderAccount: domainAccount,
        senderWalletId: routedWalletId,
        amount: { currency: "USD", cents: 700 },
        kind: "onchain",
      })
      expect(mockPayOnChainByWalletId).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ errors: [], status: "success" })
    })

    it("fails before amount resolution or payout when the guard rejects", async () => {
      mockAuthorizeSend.mockResolvedValueOnce(rejection)

      const result = await run(OnChainUsdPaymentSendMutation, input)

      expect(result.status).toBe("failed")
      expect(result.errors[0]).toMatchObject({ message: rejection.message })
      expect(mockUsdWalletAmountFromWalletId).not.toHaveBeenCalled()
      expect(mockPayOnChainByWalletId).not.toHaveBeenCalled()
    })
  })

  describe("onChainPaymentSendAll (whole balance)", () => {
    const input = {
      walletId,
      address: "bc1qexampleaddress",
      memo: null,
      speed: "FAST",
    }

    it("authorises the full balance in cents as an onchain send, then pays", async () => {
      const result = await run(OnChainPaymentSendAllMutation, input)

      expect(mockAuthorizeSend).toHaveBeenCalledWith({
        senderAccount: domainAccount,
        senderWalletId: walletId,
        amount: { currency: "USD", cents: 12345n },
        kind: "onchain",
      })
      expect(mockPayOnChainByWalletId).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ errors: [], status: "success" })
    })

    it("fails before the payout when the guard rejects", async () => {
      mockAuthorizeSend.mockResolvedValueOnce(rejection)

      const result = await run(OnChainPaymentSendAllMutation, input)

      expect(result.status).toBe("failed")
      expect(result.errors[0]).toMatchObject({ message: rejection.message })
      expect(mockPayOnChainByWalletId).not.toHaveBeenCalled()
    })
  })
})

// `authorize` used to be optional on the arg types that carry it, which meant a
// send path that simply forgot the hook compiled, passed its tests and shipped
// unguarded. Not hypothetical: `onchain-payment-send.ts` and
// `onchain-usd-payment-send-as-sats.ts` are stubbed resolvers with their full
// send bodies sitting commented out one line below, so whoever re-enables them
// gets no compile error and no failing test from an omission.
//
// `yarn tsc-check` covers test/**, so the @ts-expect-error annotations below
// ARE the test: make `authorize` optional again and each one becomes an
// "Unused '@ts-expect-error' directive" error.
describe("ENG-573: the guard hook is required, not optional", () => {
  it("refuses to type-check an intraledger send with no guard hook", () => {
    const unguarded = {
      senderWalletId: walletId,
      recipientWalletId: routedWalletId,
      amount: 100,
      memo: null,
    }
    // @ts-expect-error `authorize` is required — a send path cannot ship unguarded
    const args: IntraLedgerPaymentSendWalletIdArgs = unguarded

    expect(args).toBe(unguarded)
  })

  it("refuses to type-check a no-amount lightning send with no guard hook", () => {
    const unguarded = {
      senderWalletId: walletId,
      uncheckedPaymentRequest: "lnbc1noamount",
      amount: 700,
      memo: null,
      senderAccount: domainAccount,
    }
    // @ts-expect-error `authorize` is required — a send path cannot ship unguarded
    const args: PayNoAmountInvoiceByWalletIdArgs = unguarded

    expect(args).toBe(unguarded)
  })

  // The escape hatch, so "required" does not push somebody back to `as any`:
  // system credits opt out by name, which is also the grep that answers "what
  // still sends without the guard".
  it("accepts the named opt-out the system-credit callers use", async () => {
    const args: IntraLedgerPaymentSendWalletIdArgs = {
      senderWalletId: walletId,
      recipientWalletId: routedWalletId,
      amount: 100,
      memo: null,
      authorize: SEND_GUARD_NOT_APPLICABLE,
    }

    expect(await args.authorize()).toBe(true)
  })
})
