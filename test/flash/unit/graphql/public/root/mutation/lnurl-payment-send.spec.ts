const mockAuthorizeSend = jest.fn()
jest.mock("@app/payments/authorize-send", () => ({
  // ENG-573 send guard. Default-allow so the existing cases exercise the
  // resolver body; the wiring cases below flip it to a rejection.
  authorizeSend: async (args: unknown) => {
    const result = await mockAuthorizeSend(args)
    return result === undefined ? true : result
  },
}))

const mockResolveCashWalletMutationWalletIdForAccount = jest.fn()
const mockUsdWalletAmountFromWalletId = jest.fn()
const mockDecodeLnurl = jest.fn()
const mockPayToLnurl = jest.fn()
const mockGetSatsFromCentsForImmediateSell = jest.fn()
const mockAxiosGet = jest.fn()

const mockWithPaymentIdempotency = jest.fn()

// Passthrough by default — the wrapper's behavior is covered by
// app/payments/idempotency.spec.ts; this spec pins the resolver WIRING
// (key, wallet scope, fingerprint), the half this path got wrong by
// bypassing the wrapper entirely until ENG-533.
jest.mock("@app/payments/idempotency", () => ({
  withPaymentIdempotency: (...args: Parameters<typeof mockWithPaymentIdempotency>) =>
    mockWithPaymentIdempotency(...args),
}))

jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletMutationWalletIdForAccount: (
    ...args: Parameters<typeof mockResolveCashWalletMutationWalletIdForAccount>
  ) => mockResolveCashWalletMutationWalletIdForAccount(...args),
}))

jest.mock("@app/wallets", () => ({
  usdWalletAmountFromWalletId: (
    ...args: Parameters<typeof mockUsdWalletAmountFromWalletId>
  ) => mockUsdWalletAmountFromWalletId(...args),
}))

jest.mock("@services/dealer-price", () => ({
  DealerPriceService: jest.fn(() => ({
    getSatsFromCentsForImmediateSell: (
      ...args: Parameters<typeof mockGetSatsFromCentsForImmediateSell>
    ) => mockGetSatsFromCentsForImmediateSell(...args),
  })),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    decodeLnurl: (...args: Parameters<typeof mockDecodeLnurl>) =>
      mockDecodeLnurl(...args),
    payToLnurl: (...args: Parameters<typeof mockPayToLnurl>) => mockPayToLnurl(...args),
  },
}))

jest.mock("axios", () => ({
  get: (...args: Parameters<typeof mockAxiosGet>) => mockAxiosGet(...args),
}))

import LnurlPaymentSendMutation from "@graphql/public/root/mutation/lnurl-payment-send"
import { IdempotencyKeyReuseError, WithdrawalLimitsExceededError } from "@domain/errors"
import { paymentAmountFromNumber, USDTAmount, WalletCurrency } from "@domain/shared"
import { IbexError } from "@services/ibex/errors"

// The vendor's documented 201 body, committed verbatim — the only evidence
// this endpoint's shape has. See test/flash/mocks/ibex/pay-to-lnurl.ts.
import * as payToLnurlMock from "test/flash/mocks/ibex/pay-to-lnurl"

const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const routedWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const domainAccount = { id: "account-id" } as Account
const client = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
} as const

type MutationResult = {
  status: string
  errors: { message: string }[]
}

const resolveMutation = (overrides = {}) =>
  LnurlPaymentSendMutation.resolve?.(
    null,
    {
      input: {
        walletId,
        lnurl: "LNURL1DP68GURN8GHJ7MRWW4EXCTN" as Lnurl,
        amount: 19446 as FractionalCentAmount,
        memo: "memo" as Memo,
        ...overrides,
      },
    },
    {
      domainAccount,
      cashWalletClientCapabilities: client,
    } as GraphQLPublicContextAuth,
    {} as never,
  ) as Promise<MutationResult>

describe("LnurlPaymentSendMutation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveCashWalletMutationWalletIdForAccount.mockResolvedValue(routedWalletId)
    mockUsdWalletAmountFromWalletId.mockResolvedValue(
      USDTAmount.usdCents("19446") as USDTAmount,
    )
    mockDecodeLnurl.mockResolvedValue({
      decodedLnurl: "https://lnurl.example/.well-known/lnurlp/alice",
    })
    mockAxiosGet.mockResolvedValue({
      data: {
        callback: "https://lnurl.example/callback",
        minSendable: 1_000,
        maxSendable: 2_000_000,
        metadata: '[["text/plain","alice"]]',
        tag: "payRequest",
      },
    })
    mockGetSatsFromCentsForImmediateSell.mockResolvedValue(
      paymentAmountFromNumber({
        amount: 1234,
        currency: WalletCurrency.Btc,
      }),
    )
    mockPayToLnurl.mockResolvedValue({
      transaction: { payment: { status: { id: 2 } } },
    })
    mockWithPaymentIdempotency.mockImplementation(
      async ({ execute }: { execute: () => Promise<unknown> }) => execute(),
    )
  })

  it("decodes LNURL metadata, converts USDT wallet amount to msats, and pays IBEX", async () => {
    const result = await resolveMutation()

    expect(mockResolveCashWalletMutationWalletIdForAccount).toHaveBeenCalledWith({
      account: domainAccount,
      walletId,
      client,
    })
    expect(mockUsdWalletAmountFromWalletId).toHaveBeenCalledWith({
      walletId: routedWalletId,
      amount: "19446",
    })
    expect(mockDecodeLnurl).toHaveBeenCalledWith({
      lnurl: "LNURL1DP68GURN8GHJ7MRWW4EXCTN",
    })
    expect(mockAxiosGet).toHaveBeenCalledWith(
      "https://lnurl.example/.well-known/lnurlp/alice",
    )
    expect(mockPayToLnurl).toHaveBeenCalledWith({
      accountId: routedWalletId,
      amountMsat: 1_234_000,
      params: JSON.stringify({
        callback: "https://lnurl.example/callback",
        maxSendable: 2_000_000,
        minSendable: 1_000,
        metadata: '[["text/plain","alice"]]',
        tag: "payRequest",
      }),
    })
    expect(result).toEqual({ errors: [], status: "success" })
  })

  it("rejects converted msats below LNURL minSendable before calling IBEX pay", async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        callback: "https://lnurl.example/callback",
        minSendable: 2_000,
        maxSendable: 2_000_000,
        metadata: '[["text/plain","alice"]]',
        tag: "payRequest",
      },
    })
    mockGetSatsFromCentsForImmediateSell.mockResolvedValueOnce(
      paymentAmountFromNumber({
        amount: 1,
        currency: WalletCurrency.Btc,
      }),
    )

    const result = await resolveMutation()

    expect(mockPayToLnurl).not.toHaveBeenCalled()
    expect(result?.status).toBe("failed")
    expect(result?.errors[0].message).toMatch(/minSendable|maxSendable/i)
  })

  it("reports pending — never success — on the vendor's documented payToLnurl 201 example", async () => {
    // The committed fixture is the vendor's own example: a top-level
    // settleDateUtc of 1668544241 that is `transaction.createdAt` floored to
    // the second, next to `statusId: 0`, `payment.settleDateUtc: null`,
    // `paidMsat: 0` and `payment.hash: null`. payToLnurl also registers an
    // async settlement webhook, so the 201 is an acceptance. Reading that
    // top-level echo reported every LNURL send as a completed conversion —
    // the exact bug this PR opens by condemning.
    mockPayToLnurl.mockResolvedValueOnce(payToLnurlMock.response)

    const result = await resolveMutation()

    expect(result).toEqual({ errors: [], status: "pending" })
  })

  it("reports success on a payment-level settle date — a reading only the LNURL reader makes", async () => {
    // The payInvoiceV2 reader has no settle-date rule at all and would report
    // this as pending, so this is the assertion that catches the two readers
    // being swapped on this rail.
    mockPayToLnurl.mockResolvedValueOnce({
      hash: "19b7ff42e048d14791180d63592099b3394fc9ea7e3243906e810362124c29fd",
      transaction: {
        id: "dfeec8bd-b4e7-46f1-aa4a-cf4e4569df02",
        accountId: "eeba6152-9432-448e-b7d2-4205e5099924",
        payment: { statusId: 0, settleDateUtc: "2022-11-15T20:30:41.960887Z" },
      },
    })

    const result = await resolveMutation()

    expect(result).toEqual({ errors: [], status: "success" })
  })

  it("reports pending — never success — when the payToLnurl response carries neither status nor settle date", async () => {
    mockPayToLnurl.mockResolvedValueOnce({ transaction: { payment: { statusId: 0 } } })

    const result = await resolveMutation()

    expect(result).toEqual({ errors: [], status: "pending" })
  })

  it("maps IBEX pay failures into payload errors", async () => {
    mockPayToLnurl.mockResolvedValueOnce(new IbexError(new Error("ibex failed")))

    const result = await resolveMutation()

    expect(result?.status).toBe("failed")
    expect(result?.errors[0].message).toBeTruthy()
  })

  it("returns a failed payload — not a bare GraphQL error — when the lnurl metadata fetch rejects", async () => {
    // axios.get rejects on non-2xx and on network errors. Inside execute() a
    // bare throw would propagate through the redlock callback as an unhandled
    // GraphQL error, so the rejection must be caught and mapped like every
    // sibling branch.
    mockAxiosGet.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))

    const result = await resolveMutation()

    expect(result?.status).toBe("failed")
    expect(result?.errors[0].message).toBeTruthy()
    expect(mockPayToLnurl).not.toHaveBeenCalled()
  })

  describe("idempotency wiring (ENG-533)", () => {
    it("routes payToLnurl through withPaymentIdempotency, fingerprinting the request as sent", async () => {
      const result = (await resolveMutation({
        idempotencyKey: "11111111-2222-4333-8444-555555555555",
      })) as { errors: unknown[] }

      expect(result.errors).toEqual([])
      const call = mockWithPaymentIdempotency.mock.calls[0][0]
      expect(call.idempotencyKey).toBe("11111111-2222-4333-8444-555555555555")
      expect(call.senderWalletId).toBe(routedWalletId)
      // The fingerprint uses the client's lnurl + input amount — NOT amountMsat,
      // which moves with the dealer rate. A legitimate same-key retry must not
      // be rejected as a different payment because the price ticked.
      expect(call.requestFingerprint).toBe("lnurl|LNURL1DP68GURN8GHJ7MRWW4EXCTN|19446")
    })

    it("serves the wrapper's cached outcome without touching IBEX or the lnurl server", async () => {
      mockWithPaymentIdempotency.mockResolvedValue({ value: "success" })

      const result = (await resolveMutation({
        idempotencyKey: "11111111-2222-4333-8444-555555555555",
      })) as { status?: string }

      expect(result.status).toBe("success")
      // The replay path the wrapper exists for is exactly the one where the
      // lnurl server (the flaky dependency) may be down or the dealer rate may
      // have moved — so a cache hit must short-circuit EVERY external call,
      // not just the money-moving one. If decode or the metadata fetch runs
      // here, a cached success can be masked as a fresh failure and the user
      // re-sends with a new key: the double-pay class this PR closes.
      expect(mockDecodeLnurl).not.toHaveBeenCalled()
      expect(mockAxiosGet).not.toHaveBeenCalled()
      expect(mockUsdWalletAmountFromWalletId).not.toHaveBeenCalled()
      expect(mockPayToLnurl).not.toHaveBeenCalled()
    })

    it("maps a wrapper error (key reuse / lock busy) to a failed payload", async () => {
      mockWithPaymentIdempotency.mockResolvedValue(
        new IdempotencyKeyReuseError("same key, different payment"),
      )

      const result = (await resolveMutation({
        idempotencyKey: "11111111-2222-4333-8444-555555555555",
      })) as MutationResult

      expect(result.status).toBe("failed")
      expect(result.errors.length).toBeGreaterThan(0)
      expect(mockPayToLnurl).not.toHaveBeenCalled()
    })

    it("still executes without a key — absent key means passthrough, not rejection", async () => {
      const result = (await resolveMutation()) as MutationResult

      expect(result.errors).toEqual([])
      expect(mockWithPaymentIdempotency.mock.calls[0][0].idempotencyKey).toBeUndefined()
      expect(mockPayToLnurl).toHaveBeenCalledTimes(1)
    })
  })
})

describe("ENG-573 send guard wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveCashWalletMutationWalletIdForAccount.mockResolvedValue(routedWalletId)
    mockWithPaymentIdempotency.mockImplementation(
      async ({ execute }: { execute: () => Promise<unknown> }) => execute(),
    )
    mockDecodeLnurl.mockResolvedValue({ decodedLnurl: null })
  })

  it("authorises the cent amount against the routed wallet as an lnurl send", async () => {
    await resolveMutation()

    expect(mockAuthorizeSend).toHaveBeenCalledTimes(1)
    expect(mockAuthorizeSend).toHaveBeenCalledWith({
      senderAccount: domainAccount,
      senderWalletId: routedWalletId,
      amount: { currency: "USD", cents: 19446 },
      kind: "lnurl",
    })
    expect(mockDecodeLnurl).toHaveBeenCalledTimes(1)
  })

  it("fails before idempotency, LNURL decoding, or IBEX when the guard rejects", async () => {
    const rejection = new WithdrawalLimitsExceededError(
      "Cannot transfer more than $125.00 in 24 hours",
    )
    mockAuthorizeSend.mockResolvedValueOnce(rejection)

    const result = await resolveMutation()

    expect(result.status).toBe("failed")
    expect(result.errors[0]).toMatchObject({ message: rejection.message })
    expect(mockWithPaymentIdempotency).not.toHaveBeenCalled()
    expect(mockDecodeLnurl).not.toHaveBeenCalled()
    expect(mockPayToLnurl).not.toHaveBeenCalled()
  })
})
