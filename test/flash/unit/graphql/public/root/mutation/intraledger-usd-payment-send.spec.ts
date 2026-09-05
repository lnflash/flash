const mockAuthorizeSend = jest.fn()
jest.mock("@app/payments/authorize-send", () => ({
  // ENG-573 send guard. Default-allow so the existing cases exercise the
  // resolver body; the wiring cases below flip it to a rejection.
  authorizeSend: async (args: unknown) => {
    const result = await mockAuthorizeSend(args)
    return result === undefined ? true : result
  },
}))

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

import {
  MismatchedCurrencyForWalletError,
  IntraledgerLimitsExceededError,
} from "@domain/errors"
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

describe("ENG-573 send guard wiring", () => {
  const input = {
    walletId: senderWalletId,
    recipientWalletId,
    amount,
    memo: null,
    idempotencyKey: null,
  }

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

  it("authorises the cent amount against the routed sender wallet as an intraledger send", async () => {
    await resolve(input)

    expect(mockAuthorizeSend).toHaveBeenCalledTimes(1)
    expect(mockAuthorizeSend).toHaveBeenCalledWith({
      senderAccount: domainAccount,
      senderWalletId: routedSenderWalletId,
      amount: { currency: "USD", cents: amount },
      kind: "intraledger",
    })
    expect(mockIntraledgerPaymentSendWalletIdForUsdWallet).toHaveBeenCalledTimes(1)
  })

  it("fails after sender routing but before recipient routing or payment when the guard rejects", async () => {
    const rejection = new IntraledgerLimitsExceededError(
      "Cannot transfer more than $125.00 in 24 hours",
    )
    mockAuthorizeSend.mockResolvedValueOnce(rejection)

    const result = (await resolve(input)) as {
      status?: string
      errors: { message: string }[]
    }

    expect(result.status).toBe("failed")
    expect(result.errors[0]).toMatchObject({ message: rejection.message })
    expect(mockResolveCashWalletMutationWalletIdForAccount).toHaveBeenCalledTimes(1)
    expect(mockResolveCashWalletRecipientMutationWalletId).not.toHaveBeenCalled()
    expect(mockIntraledgerPaymentSendWalletIdForUsdWallet).not.toHaveBeenCalled()
    // the guard reports its own rejection; the resolver must not double-post
    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
  })
})
