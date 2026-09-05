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
    mockIntraledgerPaymentSendWalletIdForBtcWallet.mockResolvedValue({
      value: "success",
    })
  })

  it("authorises the sats amount as an intraledger send before any lookup", async () => {
    await resolve(input)

    expect(mockAuthorizeSend).toHaveBeenCalledTimes(1)
    expect(mockAuthorizeSend).toHaveBeenCalledWith({
      senderAccount: domainAccount,
      senderWalletId,
      amount: { currency: "BTC", sats: amount },
      kind: "intraledger",
    })
    expect(mockIntraledgerPaymentSendWalletIdForBtcWallet).toHaveBeenCalledTimes(1)
  })

  it("fails before the recipient lookup, routing, or payment when the guard rejects", async () => {
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
    expect(mockGetUsernameFromWalletId).not.toHaveBeenCalled()
    expect(mockResolveCashWalletRecipientMutationWalletId).not.toHaveBeenCalled()
    expect(mockIntraledgerPaymentSendWalletIdForBtcWallet).not.toHaveBeenCalled()
  })
})
