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

import fs from "fs"
import path from "path"

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

    // `getBalanceForWallet` returns USDAmount.ZERO for a drained or
    // never-funded wallet as a NORMAL value, not an error — post-cutover that is
    // the default read of every migrated account's legacy USD wallet. Handing
    // the guard `cents: 0n` made it reject with InvalidSendAmountError, so in
    // log-only every ordinary empty-wallet tap landed in the `invalid-amount`
    // census bucket the runbook says should be near zero — malformed client
    // input, during the very sample the enforce decision is made from. That
    // census bucket is the reason for the skip. It is NOT that the rail has a
    // nicer answer: `checkOnchainMin` returns a bare ValidationError that
    // mapError sends to the unexpected-error catch-all (pinned in
    // test/flash/unit/graphql/error-map.spec.ts).
    it.each([
      ["a zero balance", USDAmount.ZERO],
      ["sub-cent dust, which truncates to the same zero cents", USDAmount.cents("0.4")],
    ])("skips the guard on %s and lets the rail answer", async (_label, balance) => {
      mockGetBalanceForWallet.mockResolvedValueOnce(balance)

      const result = await run(OnChainPaymentSendAllMutation, input)

      expect(mockAuthorizeSend).not.toHaveBeenCalled()
      // Not authorised — refused one layer down, by OnchainUsdPaymentValidator's
      // checkOnchainMin inside payOnChainByWalletId (mocked here), exactly as
      // before ENG-573.
      expect(mockPayOnChainByWalletId).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ errors: [], status: "success" })
    })

    it("still guards a balance of one cent", async () => {
      mockGetBalanceForWallet.mockResolvedValueOnce(USDAmount.cents("1"))

      await run(OnChainPaymentSendAllMutation, input)

      expect(mockAuthorizeSend).toHaveBeenCalledWith({
        senderAccount: domainAccount,
        senderWalletId: walletId,
        amount: { currency: "USD", cents: 1n },
        kind: "onchain",
      })
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

// docs/send-guard.md, "Not covered by the guard at all", is the inventory the
// page sends a reader to before they conclude a rail is guarded — so an
// omission there is a defect, not a doc nit. It has already been wrong once:
// the Bridge USDT withdrawal rail, which carries the largest per-transaction
// amounts on the platform, was missing from it while cashout was listed.
//
// These keep page and tree in step from both directions. Wire one of these
// rails into the guard and the first assertion fails; add a new unguarded
// money-moving rail and nothing here changes until someone adds it to the list,
// at which point the second assertion makes them name it in the doc too.
describe("ENG-573: the unguarded-rail inventory in docs/send-guard.md", () => {
  const repoRoot = path.resolve(__dirname, "../".repeat(7))
  const read = (relative: string) =>
    fs.readFileSync(path.join(repoRoot, relative), "utf8")
  const doc = read("docs/send-guard.md")

  // [rail, the source that moves the money, the identifier the doc must name]
  const unguarded: [string, string, string][] = [
    ["cashout", "src/app/offers/ValidOffer.ts", "src/app/offers/ValidOffer.ts"],
    [
      "Bridge USDT withdrawal",
      "src/services/bridge/index.ts",
      "bridge-initiate-withdrawal.ts",
    ],
  ]

  it.each(unguarded)("%s still does not call the guard", (_rail, source) => {
    expect(read(source)).not.toContain("authorizeSend")
  })

  it.each(unguarded)("%s is named in the inventory", (_rail, _source, identifier) => {
    expect(doc).toContain(identifier)
  })
})
