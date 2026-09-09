const mockAuthorizeSend = jest.fn()
const mockGateSend = jest.fn()
jest.mock("@app/payments/authorize-send", () => ({
  // ENG-573 send guard. Default-allow so the existing cases exercise the
  // resolver body; the wiring cases below flip it to a rejection.
  authorizeSend: async (args: unknown) => {
    const result = await mockAuthorizeSend(args)
    return result === undefined ? true : result
  },
  // Stands in for the real `gateSend`, keeping the two behaviours under test:
  // charge the attempt budget, then report and defer to the mode. Async, like
  // the real one — the budget charge made it so, and a resolver that forgets to
  // await it would hand IBEX a `Promise` instead of a decision.
  gateSend: async (args: { error: Error }) => {
    mockGateSend(args)
    return mockSendGuardMode() === "enforce" ? args.error : true
  },
  SendRejectionReasons: {
    rateLimited: "rate-limited",
    invalidAmount: "invalid-amount",
    overDailyLimit: "over-daily-limit",
    limitsUnavailable: "limits-unavailable",
    undecodableInvoice: "undecodable-invoice",
  },
}))

const mockDecodeInvoice = jest.fn()
jest.mock("@domain/bitcoin/lightning", () => ({
  ...jest.requireActual("@domain/bitcoin/lightning"),
  // ENG-573: the resolver now decodes the bolt11 to learn the amount. The
  // fixture invoice is not a real bolt11, so decoding is stubbed to an
  // amount-bearing invoice by default. The "real bolt11" cases below route this
  // back through the genuine implementation.
  decodeInvoice: (paymentRequest: string) => mockDecodeInvoice(paymentRequest),
}))
mockDecodeInvoice.mockReturnValue({
  paymentAmount: { amount: 21_000n, currency: "BTC" },
})

// The operator switch. `off` must restore pre-ENG-573 behaviour on this rail,
// and the decode gate is part of what it has to switch off.
const mockSendGuardMode = jest.fn<SendGuardMode, []>(() => "log-only")
jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  getSendGuardMode: () => mockSendGuardMode(),
}))

const mockPayInvoice = jest.fn()
const mockRecordExceptionInCurrentSpan = jest.fn()
const mockAddEventToCurrentSpan = jest.fn()

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  addEventToCurrentSpan: (...args: unknown[]) => mockAddEventToCurrentSpan(...args),
  recordExceptionInCurrentSpan: (...args: unknown[]) =>
    mockRecordExceptionInCurrentSpan(...args),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { payInvoice: (...args: unknown[]) => mockPayInvoice(...args) },
}))

// Run the resolver's authorize()/execute() directly — idempotency plumbing is
// not under test, but the wrapper's contract (authorize, then execute, and
// neither on a replay) is, so the passthrough mirrors its no-key path.
const mockWithPaymentIdempotency = jest.fn(
  async ({
    authorize,
    execute,
  }: {
    authorize?: () => Promise<unknown>
    execute: () => Promise<unknown>
  }) => {
    const authorized = await authorize?.()
    if (authorized instanceof Error) return authorized
    return execute()
  },
)
jest.mock("@app/payments/idempotency", () => ({
  withPaymentIdempotency: (...args: Parameters<typeof mockWithPaymentIdempotency>) =>
    mockWithPaymentIdempotency(...args),
}))

import { ErrorLevel } from "@domain/shared"
import { WithdrawalLimitsExceededError } from "@domain/errors"
import { LnInvoiceDecodeError } from "@domain/bitcoin/lightning/errors"
import LnInvoicePaymentSendMutation from "@graphql/public/root/mutation/ln-invoice-payment-send"
import {
  IbexError,
  InsufficientIbexBalance,
  UnconfirmedIbexPayment,
} from "@services/ibex/errors"

const insufficientDetail =
  "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164. account: 39c6e986-979b-40ab-9e7b-df18a9277a84"
// client-facing message strips IBEX's trailing internal account UUID
const insufficientDetailStripped =
  "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164"

type PaymentSendResult = {
  status?: string
  errors: { message: string; code?: string }[]
}

const resolvePayment = async (): Promise<PaymentSendResult> => {
  const resolve = LnInvoicePaymentSendMutation.resolve as unknown as (
    source: null,
    args: { input: Record<string, unknown> },
    ctx: { domainAccount: Record<string, unknown> },
  ) => Promise<PaymentSendResult>

  return resolve(
    null,
    { input: { walletId: "wallet-1", paymentRequest: "lnbc1" } },
    { domainAccount: { id: "account-1" } },
  )
}

describe("lnInvoicePaymentSend IBEX error surfacing (issue #93)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendGuardMode.mockReturnValue("log-only")
  })

  it("returns a typed INSUFFICIENT_BALANCE error for insufficient-balance failures", async () => {
    mockPayInvoice.mockResolvedValue(
      new InsufficientIbexBalance(
        new Error("Bad Request"),
        ErrorLevel.Info,
        insufficientDetail,
      ),
    )

    const result = await resolvePayment()

    expect(result.status).toBe("failed")
    expect(result.errors[0]).toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      message: insufficientDetailStripped,
    })
    // never the internal IBEX account UUID
    expect(result.errors[0].message).not.toContain("account:")
  })

  it("keeps the generic message for other IBEX failures", async () => {
    mockPayInvoice.mockResolvedValue(new IbexError(new Error("some other 400")))

    const result = await resolvePayment()

    expect(result.status).toBe("failed")
    expect(result.errors[0].message).toBe(
      "An unexpected error occurred. Please try again later.",
    )
    expect(result.errors[0].code).toBeUndefined()
  })

  it("returns success for a settled payment", async () => {
    mockPayInvoice.mockResolvedValue({
      transaction: { payment: { status: { id: 2 } } },
    })

    const result = await resolvePayment()

    expect(result.status).toBe("success")
    expect(result.errors).toEqual([])
  })
})

// The two IBEX status readers are structurally interchangeable at the type
// level — `lnurlPaymentSendStatusOrPending` accepts a payInvoiceV2 response
// without complaint — so nothing but an assertion at the call site proves this
// resolver is wired to the payInvoiceV2 one. Wrong-reader-on-wrong-endpoint is
// exactly the bug class that had shipped on the LNURL rail, and the one thing
// the reader's own exhaustive unit suite cannot see.
describe("lnInvoicePaymentSend IBEX status reader wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendGuardMode.mockReturnValue("log-only")
  })

  it("settles on a payment-level SUCCEEDED even when the top-level status is 0", async () => {
    mockPayInvoice.mockResolvedValue({
      status: 0,
      transaction: { payment: { status: { id: 2 } } },
    })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "success" })
  })

  it("reports a corroborated top-level failure — a reading only the payInvoiceV2 reader makes", async () => {
    // payToLnurl's dialect has no top-level `status` at all, so its reader
    // would report this exact response as pending.
    mockPayInvoice.mockResolvedValue({
      status: 3,
      failureReason: 2,
      transaction: { payment: { statusId: 0 } },
    })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "failed" })
  })

  it("reports an unreadable response as pending and records it in the payInvoiceV2 reader's own words", async () => {
    // Both readers record at Warn (neither endpoint has a captured response to
    // justify paging), so severity alone no longer tells them apart — the
    // message does: the LNURL reader names payToLnurl and its payment-level
    // settle date. This is the assertion that catches the two readers being
    // swapped.
    //
    // The channel matters as much as the message: a response that claimed
    // NOTHING is recorded as a span event, not a recorded exception, because
    // recordExceptionInCurrentSpan sets the span status to ERROR
    // unconditionally and this shape may be a rail's ordinary answer.
    mockPayInvoice.mockResolvedValue({ status: 0, transaction: { payment: {} } })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "pending" })
    expect(mockRecordExceptionInCurrentSpan).not.toHaveBeenCalled()
    expect(mockAddEventToCurrentSpan).toHaveBeenCalledTimes(1)
    const [eventName, eventAttributes] = mockAddEventToCurrentSpan.mock.calls[0]
    expect(eventName).toBe("ibex.payment.unconfirmed")
    expect(eventAttributes["ibex.payment.unconfirmed.level"]).toBe(ErrorLevel.Warn)
    expect(eventAttributes["ibex.payment.unconfirmed.reason"]).toMatch(
      /No recognised payment status in IBEX response/,
    )
    expect(eventAttributes["ibex.payment.unconfirmed.reason"]).not.toMatch(/payToLnurl/)
  })

  it("never reports success from a top-level status alone", async () => {
    mockPayInvoice.mockResolvedValue({ status: 2, transaction: { payment: {} } })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "pending" })
    // An unhonoured terminal claim IS worth a red span — the payload disagrees
    // with itself and our `pending` may be wrong in a direction that moved
    // money.
    expect(mockAddEventToCurrentSpan).not.toHaveBeenCalled()
    expect(mockRecordExceptionInCurrentSpan).toHaveBeenCalledTimes(1)
    const [{ error, level }] = mockRecordExceptionInCurrentSpan.mock.calls[0]
    expect(error).toBeInstanceOf(UnconfirmedIbexPayment)
    expect(level).toBe(ErrorLevel.Warn)
    expect((error as UnconfirmedIbexPayment).uncorroboratedOutcome).toBe("SUCCEEDED")
  })

  it("never reports failure from a top-level status alone", async () => {
    // A fabricated "failed" sends the user back to retry with a fresh
    // idempotency key against a send that may already have paid.
    mockPayInvoice.mockResolvedValue({ status: 3, transaction: { payment: {} } })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "pending" })
  })
})

describe("ENG-573 send guard wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendGuardMode.mockReturnValue("log-only")
    mockDecodeInvoice.mockReturnValue({
      paymentAmount: { amount: 21_000n, currency: "BTC" },
    })
    mockPayInvoice.mockResolvedValue({
      status: 0,
      transaction: { payment: { status: { id: 2 } } },
    })
  })

  it("decodes the invoice and authorises its sats amount as a lightning send", async () => {
    await resolvePayment()

    expect(mockDecodeInvoice).toHaveBeenCalledWith("lnbc1")
    expect(mockAuthorizeSend).toHaveBeenCalledTimes(1)
    expect(mockAuthorizeSend).toHaveBeenCalledWith({
      senderAccount: { id: "account-1" },
      senderWalletId: "wallet-1",
      amount: { currency: "BTC", sats: 21_000n },
      kind: "lightning",
    })
    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
  })

  // ENG-573: the guard is the wrapper's `authorize` hook, not a call ahead of
  // it. Running it first made every retry of a timed-out send spend attempt
  // budget and get re-judged against a moved mid price, so a client past its
  // burst budget got "Too many payment attempts" instead of the cached success
  // of a payment that had already moved money.
  it("hands the guard to the idempotency wrapper instead of running it first", async () => {
    await resolvePayment()

    expect(mockWithPaymentIdempotency).toHaveBeenCalledTimes(1)
    const { authorize } = mockWithPaymentIdempotency.mock.calls[0][0]
    expect(typeof authorize).toBe("function")
  })

  it("fails before IBEX when the guard rejects", async () => {
    const rejection = new WithdrawalLimitsExceededError(
      "Cannot transfer more than $125.00 in 24 hours",
    )
    mockAuthorizeSend.mockResolvedValueOnce(rejection)

    const result = await resolvePayment()

    expect(result.status).toBe("failed")
    expect(result.errors[0]).toMatchObject({ message: rejection.message })
    expect(mockPayInvoice).not.toHaveBeenCalled()
  })

  // The decode gate used to return its error in every mode but `off`, which
  // made this the one rail that enforced while the docs and the PR said the
  // rollout was only observing — and the week-long would-reject sample carried
  // no trace of the invoices it turned away. It answers to the mode now.
  describe("the decode gate honours the mode", () => {
    for (const [label, decoded] of [
      ["a no-amount invoice", { paymentAmount: null }],
      ["an undecodable invoice", new LnInvoiceDecodeError("bad bolt11")],
    ] as const) {
      it(`reports ${label} in log-only and still pays it`, async () => {
        mockDecodeInvoice.mockReturnValue(decoded)

        const result = await resolvePayment()

        expect(mockGateSend).toHaveBeenCalledTimes(1)
        expect(mockGateSend).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "undecodable-invoice" }),
        )
        // log-only means the raw bolt11 reaches IBEX exactly as it did
        // pre-ENG-573; the guard never learns an amount, so it is not consulted.
        expect(mockPayInvoice).toHaveBeenCalledTimes(1)
        expect(result).toEqual({ errors: [], status: "success" })
        expect(mockAuthorizeSend).not.toHaveBeenCalled()
      })

      it(`refuses ${label} when enforcing`, async () => {
        mockSendGuardMode.mockReturnValue("enforce")
        mockDecodeInvoice.mockReturnValue(decoded)

        const result = await resolvePayment()

        expect(result.status).toBe("failed")
        expect(result.errors[0].message).toBeTruthy()
        expect(mockGateSend).toHaveBeenCalledTimes(1)
        expect(mockAuthorizeSend).not.toHaveBeenCalled()
        expect(mockPayInvoice).not.toHaveBeenCalled()
      })
    }
  })
})

// The decode gate is a rejection class this rail never had: before ENG-573 the
// resolver handed the raw bolt11 straight to IBEX and let IBEX judge it.
// `decodeInvoice` refuses anything `invoices.parsePaymentRequest` cannot parse
// and any invoice with no payment secret, so if it ever refuses an invoice IBEX
// would have paid, the operator switch — not a code deploy — has to be the
// remedy. That is what docs/send-guard.md promises `off` does.
describe("ENG-573 sendGuard.mode: off restores pre-ENG-573 behaviour on this rail", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendGuardMode.mockReturnValue("off")
    mockPayInvoice.mockResolvedValue({
      status: 0,
      transaction: { payment: { status: { id: 2 } } },
    })
  })

  it("still pays an invoice the decode gate refuses", async () => {
    mockDecodeInvoice.mockReturnValue(new LnInvoiceDecodeError("bad bolt11"))

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "success" })
    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
    expect(mockAuthorizeSend).not.toHaveBeenCalled()
  })

  it("still pays a no-amount invoice, as it did before the guard existed", async () => {
    mockDecodeInvoice.mockReturnValue({ paymentAmount: null })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "success" })
    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
  })

  it("does not decode at all — no Redis, no price lookup, no new rejection class", async () => {
    await resolvePayment()

    expect(mockDecodeInvoice).not.toHaveBeenCalled()
    expect(mockAuthorizeSend).not.toHaveBeenCalled()
    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
  })
})

// Every other case here stubs decodeInvoice, so none of them exercises the real
// parser on a real bolt11 — the one thing that says whether the new gate lets
// ordinary invoices through.
describe("ENG-573 decode gate against a real bolt11", () => {
  const realDecodeInvoice = jest.requireActual("@domain/bitcoin/lightning").decodeInvoice

  // 140n = 14 sats. A genuine mainnet-encoded invoice with a payment secret.
  const realInvoice =
    "lnbc140n1p3k6yzupp53p305l6de6s9xw2j0qaa59pl7lahys4f2uavwncll9z2vq0syvvsdqqcqzpgxqzuysp5mdgsaa734eg7srwx92rsn3hyc4xzt5tphfpadl5c6fanhppwaz4s9qyyssqm6yhnnhl8jltwjtclzk4g7nxr99ycsp4sqd6vksevqh06h8l3gm5fdhtl59t6g3fsalv26sj5zvwhxwlghc9wcfgkrjrtuh4873ejnspc5xksy"

  const resolveReal = async (): Promise<PaymentSendResult> => {
    const resolve = LnInvoicePaymentSendMutation.resolve as unknown as (
      source: null,
      args: { input: Record<string, unknown> },
      ctx: { domainAccount: Record<string, unknown> },
    ) => Promise<PaymentSendResult>

    return resolve(
      null,
      { input: { walletId: "wallet-1", paymentRequest: realInvoice } },
      { domainAccount: { id: "account-1" } },
    )
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockSendGuardMode.mockReturnValue("log-only")
    mockDecodeInvoice.mockImplementation(realDecodeInvoice)
    mockPayInvoice.mockResolvedValue({
      status: 0,
      transaction: { payment: { status: { id: 2 } } },
    })
  })

  it("passes an ordinary amount-bearing invoice through to IBEX with its real sats amount", async () => {
    const result = await resolveReal()

    expect(result).toEqual({ errors: [], status: "success" })
    expect(mockAuthorizeSend).toHaveBeenCalledWith({
      senderAccount: { id: "account-1" },
      senderWalletId: "wallet-1",
      amount: { currency: "BTC", sats: 14n },
      kind: "lightning",
    })
    expect(mockPayInvoice).toHaveBeenCalledWith({
      invoice: realInvoice,
      accountId: "wallet-1",
    })
  })
})
