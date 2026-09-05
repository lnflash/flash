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
    mockPayNoAmountInvoiceByWalletIdForBtcWallet.mockResolvedValue({ value: "success" })
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

    it("authorises the sats amount as a lightning send, then pays", async () => {
      const result = await run(LnNoAmountInvoicePaymentSendMutation, input)

      expect(mockAuthorizeSend).toHaveBeenCalledWith({
        senderAccount: domainAccount,
        senderWalletId: walletId,
        amount: { currency: "BTC", sats: 700 },
        kind: "lightning",
      })
      expect(mockPayNoAmountInvoiceByWalletIdForBtcWallet).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ errors: [], status: "success" })
    })

    it("fails before the app layer when the guard rejects", async () => {
      mockAuthorizeSend.mockResolvedValueOnce(rejection)

      const result = await run(LnNoAmountInvoicePaymentSendMutation, input)

      expect(result.status).toBe("failed")
      expect(result.errors[0]).toMatchObject({ message: rejection.message })
      expect(mockPayNoAmountInvoiceByWalletIdForBtcWallet).not.toHaveBeenCalled()
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
