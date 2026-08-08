const mockIntraledgerPaymentSendWalletIdForUsdWallet = jest.fn()
const mockResolveCashWalletMutationWalletIdForAccount = jest.fn()
const mockResolveCashWalletRecipientMutationWalletId = jest.fn()
const mockNotifyOpsEvent = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: Parameters<typeof mockNotifyOpsEvent>) =>
    mockNotifyOpsEvent(...args),
}))

jest.mock("@app", () => ({
  Payments: {
    intraledgerPaymentSendWalletIdForUsdWallet: (
      ...args: Parameters<typeof mockIntraledgerPaymentSendWalletIdForUsdWallet>
    ) => mockIntraledgerPaymentSendWalletIdForUsdWallet(...args),
  },
}))

jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletMutationWalletIdForAccount: (
    ...args: Parameters<typeof mockResolveCashWalletMutationWalletIdForAccount>
  ) => mockResolveCashWalletMutationWalletIdForAccount(...args),
  resolveCashWalletRecipientMutationWalletId: (
    ...args: Parameters<typeof mockResolveCashWalletRecipientMutationWalletId>
  ) => mockResolveCashWalletRecipientMutationWalletId(...args),
}))

import { MismatchedCurrencyForWalletError } from "@domain/errors"
import IntraLedgerUsdPaymentSendMutation from "@graphql/public/root/mutation/intraledger-usd-payment-send"

const senderWalletId = "11111111-1111-4111-8111-111111111111" as WalletId
const recipientWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const routedSenderWalletId = "33333333-3333-4333-8333-333333333333" as WalletId
const routedRecipientWalletId = "44444444-4444-4444-8444-444444444444" as WalletId
const amount = 1234 as UsdCents

const domainAccount = { id: "sender-account-id" } as Account

const client = {
  cashWalletPresentation: "legacy_compat",
  hasUsdtCashWalletSupport: false,
} as const

const resolve = (input: Record<string, unknown>) =>
  IntraLedgerUsdPaymentSendMutation.resolve?.(
    null,
    { input },
    { domainAccount, cashWalletClientCapabilities: client } as GraphQLPublicContextAuth,
    {} as never,
  )

describe("IntraLedgerUsdPaymentSendMutation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveCashWalletMutationWalletIdForAccount.mockResolvedValue(
      routedSenderWalletId,
    )
    mockResolveCashWalletRecipientMutationWalletId.mockResolvedValue(
      routedRecipientWalletId,
    )
    mockIntraledgerPaymentSendWalletIdForUsdWallet.mockResolvedValue({
      value: "success",
    })
  })

  it("routes both sender and recipient wallet ids through cash-wallet routing", async () => {
    const result = await resolve({
      walletId: senderWalletId,
      recipientWalletId,
      amount,
      memo: "test memo" as Memo,
      idempotencyKey: "idem-1",
    })

    expect(mockResolveCashWalletMutationWalletIdForAccount).toHaveBeenCalledWith({
      account: domainAccount,
      walletId: senderWalletId,
      client,
    })
    expect(mockResolveCashWalletRecipientMutationWalletId).toHaveBeenCalledWith({
      recipientWalletId,
      client,
    })
    expect(mockIntraledgerPaymentSendWalletIdForUsdWallet).toHaveBeenCalledWith({
      recipientWalletId: routedRecipientWalletId,
      memo: "test memo",
      amount,
      senderWalletId: routedSenderWalletId,
      senderAccount: domainAccount,
      idempotencyKey: "idem-1",
    })
    expect(result).toEqual({ errors: [], status: "success" })
    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
  })

  it("returns failed without paying when recipient routing errors", async () => {
    mockResolveCashWalletRecipientMutationWalletId.mockResolvedValue(
      new MismatchedCurrencyForWalletError(),
    )

    const result = (await resolve({
      walletId: senderWalletId,
      recipientWalletId,
      amount,
      memo: null,
      idempotencyKey: undefined,
    })) as { status?: string; errors: unknown[] }

    expect(result.status).toBe("failed")
    expect(result.errors).toHaveLength(1)
    expect(mockIntraledgerPaymentSendWalletIdForUsdWallet).not.toHaveBeenCalled()
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        status: "failed",
        error: "MismatchedCurrencyForWalletError",
        meta: expect.objectContaining({ reason: "recipient-routing" }),
      }),
    )
  })

  it("reports sender routing failures to the ops feed", async () => {
    mockResolveCashWalletMutationWalletIdForAccount.mockResolvedValue(
      new MismatchedCurrencyForWalletError(),
    )

    const result = (await resolve({
      walletId: senderWalletId,
      recipientWalletId,
      amount,
      memo: null,
      idempotencyKey: undefined,
    })) as { status?: string }

    expect(result.status).toBe("failed")
    expect(mockIntraledgerPaymentSendWalletIdForUsdWallet).not.toHaveBeenCalled()
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        status: "failed",
        meta: expect.objectContaining({ reason: "sender-routing" }),
      }),
    )
  })
})
