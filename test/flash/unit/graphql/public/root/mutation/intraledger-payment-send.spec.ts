const mockAuthorizeSend = jest.fn()
jest.mock("@app/payments/authorize-send", () => ({
  // ENG-573 send guard. Default-allow so the existing cases exercise the
  // resolver body; the wiring cases below flip it to a rejection.
  authorizeSend: async (args: unknown) => {
    const result = await mockAuthorizeSend(args)
    return result === undefined ? true : result
  },
}))

const mockIntraledgerPaymentSendWalletIdForBtcWallet = jest.fn()
const mockGetUsernameFromWalletId = jest.fn()
const mockResolveCashWalletRecipientMutationWalletId = jest.fn()
const mockNotifyOpsEvent = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: Parameters<typeof mockNotifyOpsEvent>) =>
    mockNotifyOpsEvent(...args),
}))

jest.mock("@app", () => ({
  Accounts: {
    getUsernameFromWalletId: (...args: Parameters<typeof mockGetUsernameFromWalletId>) =>
      mockGetUsernameFromWalletId(...args),
  },
  Payments: {
    intraledgerPaymentSendWalletIdForBtcWallet: (
      ...args: Parameters<typeof mockIntraledgerPaymentSendWalletIdForBtcWallet>
    ) => mockIntraledgerPaymentSendWalletIdForBtcWallet(...args),
  },
}))

jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletRecipientMutationWalletId: (
    ...args: Parameters<typeof mockResolveCashWalletRecipientMutationWalletId>
  ) => mockResolveCashWalletRecipientMutationWalletId(...args),
}))

import {
  MismatchedCurrencyForWalletError,
  IntraledgerLimitsExceededError,
} from "@domain/errors"
import IntraLedgerPaymentSendMutation from "@graphql/public/root/mutation/intraledger-payment-send"

const senderWalletId = "11111111-1111-4111-8111-111111111111" as WalletId
const recipientWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const routedRecipientWalletId = "44444444-4444-4444-8444-444444444444" as WalletId
const amount = 2100 as Satoshis

const domainAccount = { id: "sender-account-id" } as Account

const client = {
  cashWalletPresentation: "legacy_compat",
  hasUsdtCashWalletSupport: false,
} as const

const resolve = (input: Record<string, unknown>) =>
  IntraLedgerPaymentSendMutation.resolve?.(
    null,
    { input },
    { domainAccount, cashWalletClientCapabilities: client } as GraphQLPublicContextAuth,
    {} as never,
  )

describe("IntraLedgerPaymentSendMutation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetUsernameFromWalletId.mockResolvedValue("recipient" as Username)
    mockResolveCashWalletRecipientMutationWalletId.mockResolvedValue(
      routedRecipientWalletId,
    )
    mockIntraledgerPaymentSendWalletIdForBtcWallet.mockResolvedValue({
      value: "success",
    })
  })

  it("routes the recipient wallet id through cash-wallet recipient routing", async () => {
    const result = await resolve({
      walletId: senderWalletId,
      recipientWalletId,
      amount,
      memo: "test memo" as Memo,
      idempotencyKey: "idem-1",
    })

    expect(mockResolveCashWalletRecipientMutationWalletId).toHaveBeenCalledWith({
      recipientWalletId,
      client,
    })
    expect(mockIntraledgerPaymentSendWalletIdForBtcWallet).toHaveBeenCalledWith({
      recipientWalletId: routedRecipientWalletId,
      memo: "test memo",
      amount,
      senderWalletId,
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
    expect(mockIntraledgerPaymentSendWalletIdForBtcWallet).not.toHaveBeenCalled()
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        status: "failed",
        error: "MismatchedCurrencyForWalletError",
        meta: expect.objectContaining({ reason: "recipient-routing" }),
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
    mockGetUsernameFromWalletId.mockResolvedValue("recipient" as Username)
    mockResolveCashWalletRecipientMutationWalletId.mockResolvedValue(
      routedRecipientWalletId,
    )
    // Mirror the real send function's contract: it hands `authorize` to
    // withPaymentIdempotency, which runs it only on the path that will pay and
    // short-circuits on a rejection.
    mockIntraledgerPaymentSendWalletIdForBtcWallet.mockImplementation(
      async ({ authorize }: { authorize?: () => Promise<unknown> }) => {
        const authorized = await authorize?.()
        return authorized instanceof Error ? authorized : { value: "success" }
      },
    )
  })

  // ENG-573 round 2: the guard must NOT be awaited in the resolver ahead of
  // Payments.*, because withPaymentIdempotency lives inside that call. Ahead of
  // it, every retry of a timed-out send burned a burst point before reaching the
  // replay, so a client past 10/min got `{status:"failed"}` + "Too many payment
  // attempts" for a payment that had already settled — and a sats send near the
  // cap could flip to "Cannot transfer more than $X" on a mid-price tick. Both
  // are the ENG-530 double-pay class this rail's wrapper exists to prevent.
  it("hands the guard down to the send function instead of running it first", async () => {
    await resolve(input)

    expect(mockIntraledgerPaymentSendWalletIdForBtcWallet).toHaveBeenCalledTimes(1)
    const { authorize } = mockIntraledgerPaymentSendWalletIdForBtcWallet.mock.calls[0][0]
    expect(typeof authorize).toBe("function")

    // ...and it authorises the sats amount as an intraledger send when invoked.
    expect(mockAuthorizeSend).toHaveBeenCalledTimes(1)
    expect(mockAuthorizeSend).toHaveBeenCalledWith({
      senderAccount: domainAccount,
      senderWalletId,
      amount: { currency: "BTC", sats: amount },
      kind: "intraledger",
    })
  })

  it("does not consult the guard when the wrapper never runs the hook (a replay)", async () => {
    // A cached replay returns the stored result without calling authorize.
    mockIntraledgerPaymentSendWalletIdForBtcWallet.mockResolvedValueOnce({
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
  })
})
