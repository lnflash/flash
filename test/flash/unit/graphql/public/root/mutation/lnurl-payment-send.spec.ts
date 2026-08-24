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
      expect(call.requestFingerprint).toMatch(/^lnurl\|/)
      expect(call.requestFingerprint).not.toContain("Msat")
    })

    it("serves the wrapper's cached outcome without touching IBEX or the lnurl server", async () => {
      mockWithPaymentIdempotency.mockResolvedValue({ value: "success" })

      const result = (await resolveMutation({
        idempotencyKey: "11111111-2222-4333-8444-555555555555",
      })) as { status?: string }

      expect(result.status).toBe("success")
      expect(mockPayToLnurl).not.toHaveBeenCalled()
    })
  })
})
