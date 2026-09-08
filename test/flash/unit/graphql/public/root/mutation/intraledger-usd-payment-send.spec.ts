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
      // ENG-573: the guard travels down as the idempotency wrapper's hook.
      authorize: expect.any(Function),
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
    // Mirror the real send function's contract: it hands `authorize` to
    // withPaymentIdempotency, which runs it only on the path that will pay and
    // short-circuits on a rejection.
    mockIntraledgerPaymentSendWalletIdForUsdWallet.mockImplementation(
      async ({ authorize }: { authorize?: () => Promise<unknown> }) => {
        const authorized = await authorize?.()
        return authorized instanceof Error ? authorized : { value: "success" }
      },
    )
  })

  // ENG-573 round 2: awaiting the guard in the resolver put it AHEAD of
  // withPaymentIdempotency (which lives inside Payments.*), so every retry of a
  // timed-out send spent a burst point before reaching the replay — past 10/min
  // the client got "Too many payment attempts" for a payment that had already
  // settled, and a client reading that as "retry with a fresh key" double-pays.
  it("hands the guard down to the send function instead of running it first", async () => {
    await resolve(input)

    expect(mockIntraledgerPaymentSendWalletIdForUsdWallet).toHaveBeenCalledTimes(1)
    const { authorize } = mockIntraledgerPaymentSendWalletIdForUsdWallet.mock.calls[0][0]
    expect(typeof authorize).toBe("function")

    // ...and it authorises the cent amount against the ROUTED sender wallet.
    expect(mockAuthorizeSend).toHaveBeenCalledTimes(1)
    expect(mockAuthorizeSend).toHaveBeenCalledWith({
      senderAccount: domainAccount,
      senderWalletId: routedSenderWalletId,
      amount: { currency: "USD", cents: amount },
      kind: "intraledger",
    })
  })

  it("does not consult the guard when the wrapper never runs the hook (a replay)", async () => {
    mockIntraledgerPaymentSendWalletIdForUsdWallet.mockResolvedValueOnce({
      value: "success",
    })

    const result = await resolve(input)

    expect(result).toEqual({ errors: [], status: "success" })
    expect(mockAuthorizeSend).not.toHaveBeenCalled()
  })

  it("returns a failed payload carrying the guard's error when the hook rejects", async () => {
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
    // the guard reports its own rejection; the resolver must not double-post
    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
  })
})
