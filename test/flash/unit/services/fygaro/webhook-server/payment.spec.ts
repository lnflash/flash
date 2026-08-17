import { Request, Response } from "express"

const mockFygaroConfig = {
  enabled: true,
  webhook: { port: 4010, secrets: {}, timestampSkewMs: 300000 },
  credit: { enabled: false },
}

jest.mock("@config", () => ({
  get FygaroConfig() {
    return mockFygaroConfig
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/lock", () => ({
  LockService: jest.fn(() => ({
    lockIdempotencyKey: (...args: unknown[]) => mockLockIdempotencyKey(...args),
    lockPaymentIdempotencyKey: (key: unknown, fn: unknown) =>
      mockLockPaymentIdempotencyKey(key, fn),
  })),
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findByUsername: (...args: unknown[]) => mockFindByUsername(...args),
    findByUserId: (...args: unknown[]) => mockFindByUserId(...args),
  }),
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: () => ({
    getUserIdFromIdentifier: (...args: unknown[]) => mockGetUserIdFromIdentifier(...args),
  }),
}))

jest.mock("@services/frappe/fee-discounts", () => ({
  getFlashFeeDiscountPercent: (...args: unknown[]) =>
    mockGetFlashFeeDiscountPercent(...args),
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeFygaroTopupRequest: (...args: unknown[]) => mockWriteFygaroTopup(...args),
  completeFygaroTopup: (...args: unknown[]) => mockCompleteFygaroTopup(...args),
  isFygaroTopupCompleted: (...args: unknown[]) => mockIsFygaroTopupCompleted(...args),
  sumFygaroTopupGrossCentsLast24h: (...args: unknown[]) => mockSumFygaroLast24h(...args),
}))

jest.mock("@services/alerts", () => ({
  alertBridge: (...args: unknown[]) => mockAlertBridge(...args),
  // Use the REAL dedup-key generator (a pure, side-effect-free module) rather
  // than a constant stub. The static-vs-per-transaction key selection in the
  // credit-failure branch is exactly what the dedupKey assertions below pin, so
  // stubbing every key to one value would let a regressed ternary pass silently.
  generateDedupKey: jest.requireActual("@services/alerts/dedup-key").generateDedupKey,
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: unknown[]) => mockNotifyOpsEvent(...args),
}))

jest.mock("@services/fygaro/webhook-server/credit-topup", () => {
  class FygaroCreditError extends Error {
    step: string
    constructor(step: string, message: string) {
      super(message)
      this.name = "FygaroCreditError"
      this.step = step
    }
  }
  return {
    FygaroCreditError,
    INSUFFICIENT_TREASURY_FLOAT_STEP: "insufficient-treasury-float",
    creditFygaroTopup: (...args: unknown[]) => mockCreditFygaroTopup(...args),
  }
})

// The fee math (fees.ts) runs for real; only the ERPNext-backed settings read
// is mocked, so the gating matrix exercises the actual formula end to end.
jest.mock("@services/fygaro/webhook-server/fygaro-settings", () => ({
  getFygaroSettings: (...args: unknown[]) => mockGetFygaroSettings(...args),
}))

const mockLockIdempotencyKey = jest.fn()
const mockLockPaymentIdempotencyKey = jest.fn()
const mockFindByUsername = jest.fn()
const mockFindByUserId = jest.fn()
const mockGetUserIdFromIdentifier = jest.fn()
const mockGetFlashFeeDiscountPercent = jest.fn()
const mockWriteFygaroTopup = jest.fn()
const mockCompleteFygaroTopup = jest.fn()
const mockIsFygaroTopupCompleted = jest.fn()
const mockAlertBridge = jest.fn()
const mockNotifyOpsEvent = jest.fn()
const mockCreditFygaroTopup = jest.fn()
const mockGetFygaroSettings = jest.fn()
const mockSumFygaroLast24h = jest.fn()

// Canonical operator settings: 2.99% + $0.49 processor, 2.0% Flash margin,
// $500 auto-credit limit, auto-credit on. For a $10.00 top-up this yields a
// $0.79 processor fee, a $0.20 Flash fee, and $9.01 (901¢) net credited.
const DEFAULT_SETTINGS = {
  processor: "Fygaro",
  processorFeePercent: 2.99,
  processorFeeFixed: 0.49,
  flashMarginPercent: 2.0,
  flashMarginFixed: 0,
  autoCreditLimit: 500,
  minimumTopup: 10,
  autoCreditEnabled: true,
  dailyTopupLimits: { 1: 125, 2: 1000, 3: 2500 },
}

import {
  CouldNotFindAccountFromUsernameError,
  UnknownRepositoryError,
} from "@domain/errors"
import { ResourceAttemptsLockServiceError } from "@domain/lock"

import { paymentHandler } from "@services/fygaro/webhook-server/routes/payment"
import { FygaroCreditError } from "@services/fygaro/webhook-server/credit-topup"

const ACCOUNT_ID = "account-1" as AccountId
const WALLET_ID = "wallet-1" as WalletId

const VALID_BODY = {
  transactionId: "0e2f2c1a-6f6e-4f2b-9b1e-3f1a2b3c4d5e",
  reference: "FG-1042",
  customReference: "civilizedbarbarian",
  amount: "10.00",
  currency: "USD",
  authCode: null,
  createdAt: "2026-08-07T15:00:00Z",
  client: { name: "Regina Bailey", email: "regina@example.com" },
}

const makeRes = (): Response => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown>): Request =>
  ({ body }) as unknown as Request

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.credit = { enabled: false }
  mockLockIdempotencyKey.mockResolvedValue(true)
  // Releasing lock: default to acquiring and running the wrapped callback.
  mockLockPaymentIdempotencyKey.mockImplementation(
    async (_key: unknown, fn: () => Promise<unknown>) => fn(),
  )
  mockIsFygaroTopupCompleted.mockResolvedValue(false)
  mockFindByUsername.mockResolvedValue({
    id: ACCOUNT_ID,
    level: 1,
    username: VALID_BODY.customReference,
  })
  // Email fallback attribution: default to "no identity for this email".
  mockGetUserIdFromIdentifier.mockResolvedValue(new Error("IdentifierNotFoundError"))
  mockFindByUserId.mockResolvedValue(new Error("CouldNotFindError"))
  // Fee Discount whitelist: default to nobody discounted.
  mockGetFlashFeeDiscountPercent.mockResolvedValue(0)
  mockWriteFygaroTopup.mockResolvedValue(true)
  mockSumFygaroLast24h.mockResolvedValue(0)
  mockCompleteFygaroTopup.mockResolvedValue(true)
  mockCreditFygaroTopup.mockResolvedValue({ walletId: WALLET_ID, status: "success" })
  mockGetFygaroSettings.mockResolvedValue({ ...DEFAULT_SETTINGS })
})

describe("fygaro paymentHandler", () => {
  it("rejects a payload without transactionId or amount with 400", async () => {
    const res = makeRes()

    await paymentHandler(makeReq({ amount: "10.00" }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockWriteFygaroTopup).not.toHaveBeenCalled()
  })

  it("rejects a non-numeric amount with 400 and never records, credits, or alerts", async () => {
    const res = makeRes()

    await paymentHandler(makeReq({ ...VALID_BODY, amount: "abc" }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    // "abc" -> Math.round(Number("abc") * 100) is NaN. It must be rejected up
    // front, never reaching the audit/credit path where a NaN gross slips past
    // every numeric gate and gets misclassified as a CRITICAL auto-credit
    // failure that pages ops.
    expect(mockWriteFygaroTopup).not.toHaveBeenCalled()
    expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("records an attributed payment and reports pending when credit is disabled", async () => {
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: VALID_BODY.transactionId,
        amount: "10.00",
        currency: "USD",
        accountId: ACCOUNT_ID,
      }),
    )
    expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "fygaro-recorded", status: "pending" }),
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
  })

  it("still records a payment with a blank customReference and alerts as unattributed", async () => {
    const res = makeRes()

    await paymentHandler(makeReq({ ...VALID_BODY, customReference: "" }), res)

    expect(mockFindByUsername).not.toHaveBeenCalled()
    expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined }),
    )
    expect(mockAlertBridge).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "warning" }),
    )
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "fygaro-unattributed", status: "pending" }),
    )
    expect(res.json).toHaveBeenCalledWith({ status: "recorded", attributed: false })
  })

  it("treats an unknown username as unattributed", async () => {
    // The real repository signals "no account owns this username" with this
    // exact class (AccountsRepository.findByUsername) — a bare Error would not
    // distinguish a miss from a Mongo fault, which the next test pins apart.
    mockFindByUsername.mockResolvedValue(
      new CouldNotFindAccountFromUsernameError(VALID_BODY.customReference),
    )
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined }),
    )
    expect(res.json).toHaveBeenCalledWith({ status: "recorded", attributed: false })
  })

  it("returns 500 on an account-lookup FAULT instead of falling back to the payer email", async () => {
    // findByUsername returns CouldNotFindAccountFromUsernameError for a genuine
    // miss and parseRepositoryError(err) — e.g. UnknownRepositoryError — for a
    // Mongo timeout. Collapsing the two is a money bug on RE-DELIVERY: a
    // perfectly-referenced payment that was already credited would be rewritten
    // with the sticky `email_attribution` marker, which permanently exempts the
    // row from sumFygaroTopupGrossCentsSince. The account's spent daily
    // allowance would then read $0 and it could auto-credit its full cap a
    // second time inside 24h — and the 200 ack would stop Fygaro retrying, so
    // the payment strands for manual credit too. Fail transient: 500, retry.
    mockFindByUsername.mockResolvedValue(
      new UnknownRepositoryError("connection timed out"),
    )
    // Her own checkout email DOES resolve to her account — exactly the state
    // that made the collapsed branch look harmless.
    mockGetUserIdFromIdentifier.mockResolvedValue("kratos-user-1")
    mockFindByUserId.mockResolvedValue({
      id: ACCOUNT_ID,
      level: 1,
      username: VALID_BODY.customReference,
    })
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      error: "account lookup unavailable; will retry",
    })
    // The payment IS recorded — unattributed. Bailing without a write would
    // leave captured fiat with no server-side record if Fygaro's retry budget
    // expires before Mongo recovers, which is the failure class this webhook
    // exists to end. No account_id, and in particular never the sticky
    // email-attribution marker over a row whose account_id is verifiable.
    expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: VALID_BODY.transactionId,
        amount: "10.00",
        accountId: undefined,
        emailAttributed: false,
      }),
    )
    expect(mockWriteFygaroTopup).not.toHaveBeenCalledWith(
      expect.objectContaining({ emailAttributed: true }),
    )
    // The email fallback must not even be consulted.
    expect(mockGetUserIdFromIdentifier).not.toHaveBeenCalled()
    // No dedupe lock: taking the non-releasing timelock here would make the
    // very next retry ack 200 "already_processed" and defeat the self-heal.
    expect(mockLockIdempotencyKey).not.toHaveBeenCalled()
    expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
    // Ops gets PAGED — payments are landing unattributed and uncredited, the
    // same severity as the audit-write failure below. Static dedup key so one
    // outage is one incident, not one page per in-flight payment.
    expect(mockAlertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "fygaro:account-lookup-failed",
        severity: "critical",
      }),
    )
  })

  it("still answers 500 when the unattributed audit write also fails during a lookup fault", async () => {
    // Both Mongo and ERPNext are down. The response must stay 500 so Fygaro
    // retries; the failed write needs no extra handling beyond a log.
    mockFindByUsername.mockResolvedValue(
      new UnknownRepositoryError("connection timed out"),
    )
    mockWriteFygaroTopup.mockResolvedValue(new Error("erpnext down"))
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      error: "account lookup unavailable; will retry",
    })
    expect(mockLockIdempotencyKey).not.toHaveBeenCalled()
    expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
  })

  describe("payer-email fallback attribution (display-only)", () => {
    const EMAIL_ACCOUNT_ID = "account-email-match" as AccountId
    const KRATOS_USER_ID = "kratos-user-1"

    beforeEach(() => {
      mockGetUserIdFromIdentifier.mockResolvedValue(KRATOS_USER_ID)
      mockFindByUserId.mockResolvedValue({
        id: EMAIL_ACCOUNT_ID,
        level: 1,
        username: "reginab",
      })
    })

    it("stamps the email-matched account on the audit row and names it in the alert, without crediting", async () => {
      mockFygaroConfig.credit = { enabled: true }
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, customReference: "" }), res)

      expect(mockGetUserIdFromIdentifier).toHaveBeenCalledWith(VALID_BODY.client.email)
      expect(mockFindByUserId).toHaveBeenCalledWith(KRATOS_USER_ID)
      expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: EMAIL_ACCOUNT_ID,
          emailAttributed: true,
        }),
      )
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.stringContaining("@reginab"),
          context: expect.objectContaining({ email_matched_username: "reginab" }),
        }),
      )
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "fygaro-unattributed",
          accountId: EMAIL_ACCOUNT_ID,
          meta: expect.objectContaining({ emailMatchedUsername: "reginab" }),
        }),
      )
      // Email attribution is display-grade: the credit path must stay cold
      // even with the deploy gate on.
      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockGetFygaroSettings).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", attributed: false })
    })

    it("keeps the email match out of every gate — no daily-cap read, no credit", async () => {
      // The checkout email is payer-typed and identity-unverified. A relative
      // (or anyone who knows a victim's email) paying with a blank
      // customReference must not touch the named account's daily allowance or
      // its balance: the row is an audit/display artifact and nothing more.
      // The read side is enforced in ErpNext.sumFygaroTopupGrossCentsSince,
      // which skips rows marked email_attribution; here the webhook must not
      // even consult the gate.
      mockFygaroConfig.credit = { enabled: true }
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, customReference: "" }), res)

      expect(mockSumFygaroLast24h).not.toHaveBeenCalled()
      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
      // The alert must read as a lead to confirm, not an instruction to credit.
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.stringContaining("UNVERIFIED"),
        }),
      )
    })

    it("lowercases the payer email before the kratos lookup (checkout keyboards auto-capitalize)", async () => {
      // Mobile checkout keyboards auto-capitalize ("Regina@Example.com") while
      // the stored Kratos identifier is lowercase; the lookup must normalize or
      // attribution silently never fires for those payments.
      const res = makeRes()

      await paymentHandler(
        makeReq({
          ...VALID_BODY,
          customReference: "",
          client: { name: "Regina Bailey", email: " Regina@Example.COM " },
        }),
        res,
      )

      expect(mockGetUserIdFromIdentifier).toHaveBeenCalledWith("regina@example.com")
      expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: EMAIL_ACCOUNT_ID,
          emailAttributed: true,
        }),
      )
    })

    it("never attempts email attribution when customReference resolved an account", async () => {
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockGetUserIdFromIdentifier).not.toHaveBeenCalled()
      expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: ACCOUNT_ID, emailAttributed: false }),
      )
    })

    it("leaves the row unattributed when the email matches no identity", async () => {
      mockGetUserIdFromIdentifier.mockResolvedValue(new Error("IdentifierNotFoundError"))
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, customReference: "" }), res)

      expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: undefined, emailAttributed: false }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", attributed: false })
    })

    it("records unattributed when the kratos lookup throws (best-effort, never breaks the webhook)", async () => {
      mockGetUserIdFromIdentifier.mockRejectedValue(new Error("kratos down"))
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, customReference: "" }), res)

      expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: undefined }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", attributed: false })
    })

    it("skips the lookup entirely for a payload without a client email", async () => {
      const res = makeRes()

      await paymentHandler(
        makeReq({ ...VALID_BODY, customReference: "", client: { name: "X" } }),
        res,
      )

      expect(mockGetUserIdFromIdentifier).not.toHaveBeenCalled()
      expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: undefined }),
      )
    })
  })

  it("returns 500 when the ERPNext audit write fails so Fygaro retries", async () => {
    mockWriteFygaroTopup.mockResolvedValue(new Error("erpnext down"))
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(mockAlertBridge).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical" }),
    )
    expect(res.status).toHaveBeenCalledWith(500)
    expect(mockLockIdempotencyKey).not.toHaveBeenCalled()
  })

  it("acknowledges a duplicate record-only delivery without reprocessing", async () => {
    mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
  })

  it("dedupes re-deliveries of an unattributed payment before emitting the ops event", async () => {
    mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))
    const res = makeRes()

    await paymentHandler(makeReq({ ...VALID_BODY, customReference: "" }), res)

    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    expect(mockAlertBridge).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
  })

  describe("with credit enabled", () => {
    beforeEach(() => {
      mockFygaroConfig.credit = { enabled: true }
    })

    it("credits the NET (not gross) and promotes the audit row with the fee breakdown", async () => {
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      // $10.00 gross -> $0.79 processor + $0.20 flash -> $9.01 (901¢) net
      expect(mockCreditFygaroTopup).toHaveBeenCalledWith({
        recipientAccountId: ACCOUNT_ID,
        amountCents: 901,
        transactionId: VALID_BODY.transactionId,
      })
      expect(mockCompleteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: VALID_BODY.transactionId,
          accountId: ACCOUNT_ID,
          walletId: WALLET_ID,
          initialAmount: "10.00",
          processorFee: "0.79",
          flashFee: "0.20",
          finalAmount: "9.01",
        }),
      )
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "succeeded", status: "success" }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })

    it("consults the Fee Discount whitelist for the account's username in the topup flow", async () => {
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockGetFlashFeeDiscountPercent).toHaveBeenCalledWith({
        username: VALID_BODY.customReference,
        flow: "topup",
      })
    })

    it("credits with a discounted flash fee and promotes the discounted breakdown", async () => {
      mockGetFlashFeeDiscountPercent.mockResolvedValue(50)
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      // $10.00 gross -> $0.79 processor + $0.10 flash (50% off $0.20) -> $9.11 net
      expect(mockCreditFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 911 }),
      )
      expect(mockCompleteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({
          processorFee: "0.79",
          flashFee: "0.10",
          finalAmount: "9.11",
        }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })

    it("waives the flash fee entirely at a 100% discount (processor fee still applies)", async () => {
      mockGetFlashFeeDiscountPercent.mockResolvedValue(100)
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 921 }),
      )
      expect(mockCompleteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({
          processorFee: "0.79",
          flashFee: "0.00",
          finalAmount: "9.21",
        }),
      )
    })

    it("does not consult the whitelist when auto-credit is disabled in settings", async () => {
      mockGetFygaroSettings.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        autoCreditEnabled: false,
      })
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockGetFlashFeeDiscountPercent).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("records without crediting and fires the generic critical when the credit fails", async () => {
      mockCreditFygaroTopup.mockResolvedValue(
        new FygaroCreditError("intraledger-send", "some send error"),
      )
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          // A generic credit failure MUST keep the per-transaction dedup key so
          // each stranded payment pages ops individually — pinned here so a
          // regression to the static float-exhausted key (which would collapse
          // distinct manual-credit failures into one page) fails the test.
          dedupKey: `fygaro:credit-failed:${VALID_BODY.transactionId}`,
          severity: "critical",
          title: "Fygaro auto-credit failed — manual credit needed",
        }),
      )
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", step: "credit:intraledger-send" }),
      )
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("fires the distinct float-EXHAUSTED critical when the treasury can't cover the send", async () => {
      mockCreditFygaroTopup.mockResolvedValue(
        new FygaroCreditError("insufficient-treasury-float", "insufficient balance"),
      )
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          // The exhausted branch MUST swap the per-transaction key for the
          // STATIC float-exhausted key so a treasury-outage run of failing
          // credits collapses to ONE PagerDuty page instead of one-per-tx.
          // Pinned so a regression back to the per-transaction key fails here.
          dedupKey: "fygaro:float-exhausted",
          severity: "critical",
          title: "Fygaro treasury float EXHAUSTED — top up bankowner immediately",
        }),
      )
      // The row still stays Fiat Received — the existing safety is unchanged.
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("short-circuits when the audit row is already Completed (processed re-delivery)", async () => {
      mockIsFygaroTopupCompleted.mockResolvedValue(true)
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
    })

    it("re-runs the credit when a retry arrives after an incomplete first attempt", async () => {
      // Row still Fiat Received (crash or promotion failure last time):
      // the credit path must run again — withPaymentIdempotency makes the
      // send replay-safe — so the retry self-heals instead of stranding.
      mockIsFygaroTopupCompleted.mockResolvedValue(false)
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).toHaveBeenCalledTimes(1)
      expect(mockCompleteFygaroTopup).toHaveBeenCalledTimes(1)
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })

    it("acknowledges without crediting when another delivery holds the credit lock", async () => {
      mockLockPaymentIdempotencyKey.mockResolvedValue(
        new ResourceAttemptsLockServiceError(),
      )
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "already_processing" })
    })

    it("returns 500 with a critical alert when the credit block threw (not contention)", async () => {
      // redlock reports a swallowed callback throw as a generic lock error —
      // that must NOT be acked as already_processing, or Fygaro stops
      // retrying and the payment strands at Fiat Received silently.
      mockLockPaymentIdempotencyKey.mockResolvedValue(
        new Error("UnknownLockServiceError"),
      )
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({ severity: "critical" }),
      )
      expect(res.status).toHaveBeenCalledWith(500)
    })

    it("never auto-credits a non-USD payment", async () => {
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, currency: "JMD" }), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({ severity: "warning" }),
      )
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "fygaro-recorded",
          meta: expect.objectContaining({ reason: "non-usd" }),
        }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    // Gating matrix: each DETERMINISTIC failing gate records-only (200), fires
    // exactly one reason-named ops alert, and never credits. `settings-
    // unavailable` is intentionally NOT here — it is transient and returns 500
    // (see its dedicated test below) so Fygaro retries and the read self-heals.
    it.each([
      [
        "auto-credit-disabled",
        (body: Record<string, unknown>) => body,
        () =>
          mockGetFygaroSettings.mockResolvedValue({
            ...DEFAULT_SETTINGS,
            autoCreditEnabled: false,
          }),
      ],
      [
        "over-limit",
        (body: Record<string, unknown>) => ({ ...body, amount: "500.01" }),
        () => undefined,
      ],
      [
        "under-minimum",
        // $2.00 vs the $10 default minimum: positive net, but below the minimum.
        (body: Record<string, unknown>) => ({ ...body, amount: "2.00" }),
        () => undefined,
      ],
      [
        "non-positive-net",
        (body: Record<string, unknown>) => ({ ...body, amount: "0.10" }),
        () => undefined,
      ],
      [
        "daily-limit-exceeded",
        // $30 now on top of $100 already charged today busts the L1 $125 cap.
        (body: Record<string, unknown>) => ({ ...body, amount: "30.00" }),
        () => mockSumFygaroLast24h.mockResolvedValue(10000),
      ],
      [
        "no-daily-limit-for-level",
        // A level-0 account has no configured daily allowance — fail closed.
        (body: Record<string, unknown>) => body,
        () => mockFindByUsername.mockResolvedValue({ id: ACCOUNT_ID, level: 0 }),
      ],
    ])(
      "records-only and alerts %s without crediting",
      async (reason, mutateBody, arrange) => {
        arrange()
        const res = makeRes()

        await paymentHandler(makeReq(mutateBody(VALID_BODY)), res)

        expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
        expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
        expect(mockAlertBridge).toHaveBeenCalledTimes(1)
        expect(mockAlertBridge).toHaveBeenCalledWith(
          expect.objectContaining({
            severity: "warning",
            context: expect.objectContaining({ reason }),
          }),
        )
        expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: "fygaro-recorded",
            status: "pending",
            meta: expect.objectContaining({ reason }),
          }),
        )
        expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
      },
    )

    it("returns 500 for settings-unavailable so Fygaro retries (transient), without acking or spamming the feed", async () => {
      // A brief ERPNext blip caches settings as undefined for up to 60s. That
      // must NOT permanently downgrade the payment to manual credit: return 500
      // so Fygaro retries and a recovered read auto-credits cleanly.
      mockGetFygaroSettings.mockResolvedValue(undefined)
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
      // The non-releasing dedupe lock is deliberately NOT taken here — taking it
      // would make the very next retry ack 200 "already_processed" and defeat
      // the self-heal.
      expect(mockLockIdempotencyKey).not.toHaveBeenCalled()
      // Paged via alertBridge (TTL-deduped); no ops-feed line, which cannot be
      // deduped without the lock and would otherwise spam per retry.
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "warning",
          context: expect.objectContaining({ reason: "settings-unavailable" }),
        }),
      )
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(500)
    })

    it("returns 500 for history-unavailable so Fygaro retries (transient), without acking or spamming the feed", async () => {
      // Same transient contract as settings-unavailable: a failed trailing-24h
      // read must never be treated as a clean slate NOR permanently downgrade
      // the payment to manual credit — 500 lets the provider retry re-read it.
      mockSumFygaroLast24h.mockResolvedValue(new Error("erpnext down"))
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
      expect(mockLockIdempotencyKey).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "warning",
          context: expect.objectContaining({ reason: "history-unavailable" }),
        }),
      )
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(500)
    })

    it("credits a payment landing exactly ON the daily cap and excludes its own audit row from the sum", async () => {
      // $100 earlier + $25 now = exactly the L1 $125 cap (inclusive).
      mockSumFygaroLast24h.mockResolvedValue(10000)
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, amount: "25.00" }), res)

      // The trailing-24h sum must exclude THIS delivery's audit row (written
      // before the gate) or every payment would double-count itself.
      expect(mockSumFygaroLast24h).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        excludeTransactionId: VALID_BODY.transactionId,
      })
      // $25.00 gross -> $1.24 processor + $0.50 flash -> $23.26 (2326¢) net
      expect(mockCreditFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 2326 }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })

    it("does not read Fygaro Settings or top-up history when credit is disabled at deploy level", async () => {
      mockFygaroConfig.credit = { enabled: false }
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockGetFygaroSettings).not.toHaveBeenCalled()
      expect(mockSumFygaroLast24h).not.toHaveBeenCalled()
      expect(mockAlertBridge).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "fygaro-recorded" }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("does not read top-up history when settings are unavailable", async () => {
      mockGetFygaroSettings.mockResolvedValue(undefined)
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockSumFygaroLast24h).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(500)
    })

    it("does not read top-up history when auto-credit is disabled in settings", async () => {
      // The operator kill switch fails the gate deterministically before the
      // history gates, so the ERPNext list query is a wasted read per webhook
      // — it must be skipped, and skipping it must still record-only on
      // `auto-credit-disabled`, never a false transient `history-unavailable`.
      mockGetFygaroSettings.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        autoCreditEnabled: false,
      })
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockSumFygaroLast24h).not.toHaveBeenCalled()
      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "fygaro-recorded",
          meta: expect.objectContaining({ reason: "auto-credit-disabled" }),
        }),
      )
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("does not read top-up history for a non-USD payment", async () => {
      // Same ordering argument as the kill switch: `non-usd` fails the gate
      // before the history gates, so the read would never be consumed.
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, currency: "JMD" }), res)

      expect(mockSumFygaroLast24h).not.toHaveBeenCalled()
      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "fygaro-recorded",
          meta: expect.objectContaining({ reason: "non-usd" }),
        }),
      )
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("credits a payment sitting exactly at the auto-credit limit", async () => {
      // Level 2 so the $1000 daily cap does not shadow the $500 auto-credit
      // limit this test is pinning.
      mockFindByUsername.mockResolvedValue({ id: ACCOUNT_ID, level: 2 })
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, amount: "500.00" }), res)

      // $500 gross -> $15.44 processor + $10.00 flash -> $474.56 (47456¢) net
      expect(mockCreditFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 47456 }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })

    it("still reports success when only the ERPNext promotion fails after a credit", async () => {
      mockCompleteFygaroTopup.mockResolvedValue(new Error("erpnext down"))
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({ severity: "warning" }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })
  })
})
