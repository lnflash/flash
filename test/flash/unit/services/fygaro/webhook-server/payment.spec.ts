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
  readFygaroTopupCompletion: (...args: unknown[]) => mockReadCompletion(...args),
  sumFygaroTopupGrossCentsLast24h: (...args: unknown[]) => mockSumFygaroLast24h(...args),
  markFygaroTopupNotCredited: (...args: unknown[]) => mockMarkNotCredited(...args),
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

// Redis-backed store for the pre-charge authorisation. Read and redemption are
// separate calls on purpose (a delivery that will be retried must not burn the
// intent), so both are mocked and both are asserted on below.
jest.mock("@services/fygaro/checkout-intent-store", () => ({
  readIntent: (...args: unknown[]) => mockReadIntent(...args),
  consumeIntent: (...args: unknown[]) => mockConsumeIntent(...args),
  releaseIntentReservation: (...args: unknown[]) => mockReleaseIntentReservation(...args),
  recordIntentOutcome: (...args: unknown[]) => mockRecordIntentOutcome(...args),
  // NOT mocked. Mocking `recordIntentOutcome` means this suite asserts the CALL
  // and never the RECORD, and the two are not the same thing: the store's merge
  // rules can drop a stamp the handler was right to make. That is exactly how a
  // handler test and a store test came to be green while claiming opposite
  // things about a link paid twice. The real merge is pure and drags in no
  // Redis (the store defers `@services/cache`/`@services/redis` to first use),
  // so the already-credited test below replays its stamps through it and
  // asserts what the customer would actually be shown.
  mergeIntentOutcome: jest.requireActual("@services/fygaro/checkout-intent-store")
    .mergeIntentOutcome,
}))

const mockRecordIntentOutcome = jest.fn()
const mockLockIdempotencyKey = jest.fn()
const mockLockPaymentIdempotencyKey = jest.fn()
const mockFindByUsername = jest.fn()
const mockFindByUserId = jest.fn()
const mockGetUserIdFromIdentifier = jest.fn()
const mockGetFlashFeeDiscountPercent = jest.fn()
const mockWriteFygaroTopup = jest.fn()
const mockCompleteFygaroTopup = jest.fn()
const mockReadCompletion = jest.fn()
const mockAlertBridge = jest.fn()
const mockNotifyOpsEvent = jest.fn()
const mockCreditFygaroTopup = jest.fn()
const mockGetFygaroSettings = jest.fn()
const mockSumFygaroLast24h = jest.fn()
const mockMarkNotCredited = jest.fn()
const mockReadIntent = jest.fn()
const mockConsumeIntent = jest.fn()
const mockReleaseIntentReservation = jest.fn()

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
import { WalletCurrency } from "@domain/shared"

import { paymentHandler } from "@services/fygaro/webhook-server/routes/payment"
import { FygaroCreditError } from "@services/fygaro/webhook-server/credit-topup"
// The REAL merge (see the mock factory above): a stamp the handler makes is only
// worth what the store keeps of it.
import {
  mergeIntentOutcome,
  type FygaroTopupOutcome,
} from "@services/fygaro/checkout-intent-store"

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
  mockReadCompletion.mockResolvedValue({ completed: false })
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
  mockMarkNotCredited.mockResolvedValue(true)
  mockRecordIntentOutcome.mockResolvedValue(undefined)
  mockCompleteFygaroTopup.mockResolvedValue(true)
  mockCreditFygaroTopup.mockResolvedValue({
    walletId: WALLET_ID,
    walletCurrency: WalletCurrency.Usdt,
    status: "success",
  })
  mockGetFygaroSettings.mockResolvedValue({ ...DEFAULT_SETTINGS })
  // Legacy default: the reference carries no intent, so nothing is looked up.
  mockReadIntent.mockResolvedValue({ found: false })
  mockConsumeIntent.mockResolvedValue({ consumed: true })
  mockReleaseIntentReservation.mockResolvedValue(undefined)
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

  it("stamps an outcome on a DEDUPED unattributed re-delivery", async () => {
    // The third terminal return, and the one the first two fixes missed. If the
    // first delivery's Redis stamp failed (swallowed by design), every retry
    // short-circuits on the dedupe lock — so without a stamp here the app polls
    // PROCESSING until the record expires, on a payment ops is crediting by hand.
    const intentId = "9c1f7e42-5a3b-4d18-8e07-2b6a9f1c4d33"
    // No account owns this username, so the handler takes the unattributed
    // branch — where the dedupe short-circuit lives.
    mockFindByUsername.mockResolvedValue(
      new CouldNotFindAccountFromUsernameError("unknown-user"),
    )
    mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))
    const res = makeRes()

    await paymentHandler(
      makeReq({ ...VALID_BODY, customReference: `unknown-user|${intentId}` }),
      res,
    )

    expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId,
        outcome: expect.objectContaining({
          state: "held-for-review",
          reason: "unattributed",
        }),
      }),
    )
    expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
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
      mockReadCompletion.mockResolvedValue({ completed: true })
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
      mockReadCompletion.mockResolvedValue({ completed: false })
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

    it("pages CRITICAL when the not-credited stamp fails, instead of failing silently", async () => {
      // The write that carries the whole point of the record-only path. The
      // dedupe timelock above it is non-releasing and already taken, so Fygaro
      // never retries and nothing self-heals: the row keeps no failure_reason,
      // stays inside the trailing-24h sum, and this refused $30 goes on eating
      // the customer's $125 cap for 24h — refusing their next LEGITIMATE
      // top-up, which is the exact failure this stamp exists to end.
      mockSumFygaroLast24h.mockResolvedValue(10000)
      mockMarkNotCredited.mockResolvedValue(new Error("erpnext PUT timed out"))
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, amount: "30.00" }), res)

      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "erpnext-audit",
          severity: "critical",
          context: expect.objectContaining({
            transaction_id: VALID_BODY.transactionId,
            reason: "daily-limit-exceeded",
          }),
        }),
      )
    })

    it("raises the not-stamped CRITICAL under its OWN dedup key", async () => {
      // It used to share `erpnext-audit:fygaro:<tx>` with the audit-WRITE
      // failure — and the delivery order that produces THIS failure is exactly
      // the one that produces that one first: write fails, critical fires, 500,
      // Fygaro retries minutes later, the write succeeds, the gate refuses, and
      // the stamp fails. Inside informDedupTtlMs (60 minutes) Slack/Discord
      // suppress the second alert and PagerDuty folds it into the open
      // incident, so the page that says a customer's cap is being eaten by a
      // payment they got nothing for is silently swallowed.
      mockSumFygaroLast24h.mockResolvedValue(10000)
      mockMarkNotCredited.mockResolvedValue(new Error("erpnext PUT timed out"))
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, amount: "30.00" }), res)

      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupKey: `fygaro:refusal-not-stamped:${VALID_BODY.transactionId}`,
          severity: "critical",
        }),
      )
      const notStamped = mockAlertBridge.mock.calls
        .map(([alert]: [{ dedupKey: string; title: string }]) => alert)
        .find(({ title }) => title.startsWith("Fygaro refusal not stamped"))
      expect(notStamped?.dedupKey).not.toBe(
        `erpnext-audit:fygaro:${VALID_BODY.transactionId}`,
      )
    })

    it("still refuses nothing when the credit landed but ERPNext never promoted it", async () => {
      // The ERPNext row is the marker the guard used to trust ALONE, and it is
      // the very write this handler alerts on when it fails ("credit succeeded
      // but ERPNext promotion failed"). After that the money IS in the wallet
      // and the row still reads Fiat Received. The reasons that reach here are
      // ordinary — auto-credit-disabled is exactly what ops flip while cleaning
      // up the same ERPNext incident that broke the promotion.
      const intentId = "b41f7c02-9e35-4d6a-8f11-3a7c5d29e604"
      mockReadCompletion.mockResolvedValue({ completed: false })
      mockReadIntent.mockResolvedValue({
        found: true,
        intent: {
          intentId,
          accountId: ACCOUNT_ID,
          username: "alice",
          amountCents: 3000,
          currency: "USD",
          createdAtMs: 1,
          // Stamped by THIS transaction's own credit. The marker is only an
          // answer about the payment it names — see the sibling test below,
          // where the same intent carries a different transaction's credit.
          outcome: {
            state: "credited",
            netAmountCents: 2852,
            transactionId: VALID_BODY.transactionId,
            atMs: 1,
          },
        },
      })
      mockSumFygaroLast24h.mockResolvedValue(10000)
      const res = makeRes()

      await paymentHandler(
        makeReq({
          ...VALID_BODY,
          amount: "30.00",
          customReference: `alice|${intentId}`,
        }),
        res,
      )

      expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
      expect(mockMarkNotCredited).not.toHaveBeenCalled()
      // And the net already recorded survives, rather than being replaced by a
      // credited stamp with no figure.
      expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: expect.objectContaining({ state: "credited", netAmountCents: 2852 }),
        }),
      )
    })

    it("stamps every outcome with the transaction it is about", async () => {
      // The record is keyed on the INTENT and a link can be paid twice, so an
      // outcome that does not name its payment cannot be used to decide
      // anything about a different one — which is exactly what the
      // already-credited guard below does with it.
      mockSumFygaroLast24h.mockResolvedValue(10000)

      await paymentHandler(
        makeReq({
          ...VALID_BODY,
          amount: "30.00",
          customReference: `${VALID_BODY.customReference}|3f5a1c9e-2b7d-4a10-9f33-6c8e2d4b7a51`,
        }),
        makeRes(),
      )

      expect(mockRecordIntentOutcome).toHaveBeenCalled()
      for (const [{ outcome }] of mockRecordIntentOutcome.mock.calls) {
        expect(outcome.transactionId).toBe(VALID_BODY.transactionId)
      }
    })

    it("does NOT treat another transaction's credit as this one being already credited", async () => {
      // The webhook decision is TRANSACTION-scoped: tx2 must be refused on its
      // own merits, stamped uncredited in ERPNext and alerted. What the shared
      // per-intent record ends up saying is a separate question, settled below.
      // The marker is INTENT-scoped; the decision is TRANSACTION-scoped. One
      // signed link can be paid twice inside its 900s window — the replay
      // authorize-topup guards against — so tx1's credit says nothing about
      // tx2. Trusting it acks tx2 200 "already_processed": no
      // markFygaroTopupNotCredited (so a payment that delivered NOTHING eats
      // the customer's cap for 24h), no ops alert, and fygaroTopupStatus
      // reporting CREDITED with tx1's net for a second real $100 capture that
      // never reached the wallet.
      const intentId = "b41f7c02-9e35-4d6a-8f11-3a7c5d29e604"
      const CREDITED_BY_ANOTHER_TX: FygaroTopupOutcome = {
        state: "credited",
        netAmountCents: 9421,
        transactionId: "a1111111-2222-3333-4444-555555555555",
        atMs: 1,
      }
      mockReadCompletion.mockResolvedValue({ completed: false })
      mockReadIntent.mockResolvedValue({
        found: true,
        intent: {
          intentId,
          accountId: ACCOUNT_ID,
          username: VALID_BODY.customReference,
          amountCents: 10000,
          currency: "USD",
          createdAtMs: 1,
          outcome: CREDITED_BY_ANOTHER_TX,
        },
      })
      // $100 already charged against the $125 L1 cap, so this second $100 is
      // genuinely over it.
      mockSumFygaroLast24h.mockResolvedValue(10000)
      const res = makeRes()

      await paymentHandler(
        makeReq({
          ...VALID_BODY,
          amount: "100.00",
          customReference: `${VALID_BODY.customReference}|${intentId}`,
        }),
        res,
      )

      // Recorded and refused on its own merits, not swallowed.
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
      // Out of the allowance sum: an uncredited payment must not go on
      // consuming the cap that governs value delivered.
      expect(mockMarkNotCredited).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: VALID_BODY.transactionId,
          reason: "daily-limit-exceeded",
        }),
      )
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "warning",
          context: expect.objectContaining({ reason: "daily-limit-exceeded" }),
        }),
      )
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "fygaro-recorded" }),
      )
      // ...and the stamp is the truth about THIS payment.
      const stamped = mockRecordIntentOutcome.mock.calls
        .map(([args]: [{ outcome: FygaroTopupOutcome }]) => args.outcome)
        .filter(({ state }) => state !== "received")
      expect(stamped).toEqual([
        expect.objectContaining({
          state: "held-for-review",
          reason: "daily-limit-exceeded",
          transactionId: VALID_BODY.transactionId,
        }),
      ])

      // The RECORD, by contrast, deliberately keeps `credited`. It has ONE
      // outcome slot and this link has two payments, so some ordering of
      // deliveries contradicts some stamp whatever rule is chosen — and the
      // only claim that is irreversibly true is that money reached the wallet.
      // Scoping absorbency to the payment instead left a "last stamp wins"
      // fall-through, and a routine re-delivery of tx1 then walked the record
      // back and forth between "money is in your wallet" and "we're completing
      // it manually".
      //
      // tx2 is not lost by that, which is the point of the assertions ABOVE:
      // its ERPNext row is stamped uncredited (so it leaves the 24h allowance
      // sum) and a human is paged. Only the customer-facing record stays on the
      // credit that genuinely landed.
      const recorded = mockRecordIntentOutcome.mock.calls.reduce(
        (
          record: FygaroTopupOutcome | undefined,
          [args]: [{ outcome: FygaroTopupOutcome }],
        ) => mergeIntentOutcome(record, args.outcome) ?? record,
        CREDITED_BY_ANOTHER_TX,
      )
      expect(recorded).toMatchObject({ state: "credited" })
    })

    it("does NOT let another transaction's credit swallow an intent-mismatch", async () => {
      // `intent-mismatch` is the one gate reason that exists to catch a replay,
      // so an intent-scoped credited marker swallowing it disarms the very
      // check that would have caught the replay stamping the marker.
      const intentId = "c5271f80-1a44-4c8e-9d02-77b3e6a1f409"
      mockReadCompletion.mockResolvedValue({ completed: false })
      mockReadIntent.mockResolvedValue({
        found: true,
        intent: {
          intentId,
          accountId: ACCOUNT_ID,
          username: VALID_BODY.customReference,
          amountCents: 10000,
          currency: "USD",
          createdAtMs: 1,
          outcome: {
            state: "credited",
            netAmountCents: 9421,
            transactionId: "a1111111-2222-3333-4444-555555555555",
            atMs: 1,
          },
        },
      })
      const res = makeRes()

      // Authorised $100, paid $30 — a mismatch on OUR side.
      await paymentHandler(
        makeReq({
          ...VALID_BODY,
          amount: "30.00",
          customReference: `${VALID_BODY.customReference}|${intentId}`,
        }),
        res,
      )

      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
      expect(mockMarkNotCredited).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "intent-mismatch" }),
      )
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ reason: "intent-mismatch" }),
        }),
      )
    })

    it("never refuses a payment that has ALREADY been credited", async () => {
      // Reachable, and it costs real money: tx1 ($60) credits; tx2 ($100) is
      // refused daily-limit-exceeded and hand-credited by ops, which correctly
      // puts it back into the trailing-24h sum; Fygaro then re-delivers tx1.
      // The record-only timelock lives in a different redis namespace from the
      // credit path's lock, so it is still free and cannot stop this. Unguarded,
      // the gate refuses money already in the wallet: a false "manual credit
      // needed" page, a failure_reason stamped onto a Completed row, and the
      // customer's CREDITED status overwritten with "held for review".
      mockReadCompletion.mockResolvedValue({ completed: true })
      mockSumFygaroLast24h.mockResolvedValue(10000)
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, amount: "30.00" }), res)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
      expect(mockMarkNotCredited).not.toHaveBeenCalled()
      expect(mockAlertBridge).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
      // Checked BEFORE the non-releasing record-only timelock, so a re-delivery
      // is not silently converted into a consumed lock either.
      expect(mockLockIdempotencyKey).not.toHaveBeenCalled()
    })

    it("re-stamps CREDITED, not held-for-review, on a refused re-delivery of a credited payment", async () => {
      // ...and with the NET read back off the completed ERPNext row. This
      // branch exists precisely for the case where the FIRST delivery's stamp
      // never landed, so there is usually no recorded outcome for the store's
      // merge to preserve: stamping `credited` with no amount would show the
      // customer a credited top-up and no figure, against a schema that
      // promises `netAmount` is present once credited.
      mockReadCompletion.mockResolvedValue({ completed: true, netAmountCents: 2851 })
      mockSumFygaroLast24h.mockResolvedValue(10000)
      const res = makeRes()

      await paymentHandler(
        makeReq({
          ...VALID_BODY,
          customReference: `${VALID_BODY.customReference}|3f5a1c9e-2b7d-4a10-9f33-6c8e2d4b7a51`,
          amount: "30.00",
        }),
        res,
      )

      expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: expect.objectContaining({ state: "credited", netAmountCents: 2851 }),
        }),
      )
    })

    it("stamps credited with no figure rather than a wrong one when the row has no net", async () => {
      // An older row, or one promoted by a path that wrote no fee breakdown.
      // The state is still the truth; a fabricated amount would not be.
      mockReadCompletion.mockResolvedValue({ completed: true })
      mockSumFygaroLast24h.mockResolvedValue(10000)
      const res = makeRes()

      await paymentHandler(
        makeReq({
          ...VALID_BODY,
          customReference: `${VALID_BODY.customReference}|3f5a1c9e-2b7d-4a10-9f33-6c8e2d4b7a51`,
          amount: "30.00",
        }),
        res,
      )

      const stamped = mockRecordIntentOutcome.mock.calls
        .map(([args]: [{ outcome: { state: string; netAmountCents?: number } }]) => args)
        .filter(({ outcome }) => outcome.state === "credited")
      expect(stamped).toHaveLength(1)
      expect(stamped[0].outcome.netAmountCents).toBeUndefined()
    })

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

  // The pre-charge authorisation cross-check. This is the branch that decides
  // whether a payment we cannot account for gets credited anyway, so every arm
  // of it is pinned: match, both mismatch shapes, and the legacy fall-through.
  describe("checkout intent cross-check", () => {
    const INTENT_ID = "3f5a1c9e-2b7d-4a10-9f33-6c8e2d4b7a51"
    const SIGNED_BODY = {
      ...VALID_BODY,
      customReference: `${VALID_BODY.customReference}|${INTENT_ID}`,
    }
    const intent = (overrides: Record<string, unknown> = {}) => ({
      found: true,
      intent: {
        intentId: INTENT_ID,
        accountId: ACCOUNT_ID as string,
        username: VALID_BODY.customReference,
        // $10.00, matching VALID_BODY.amount
        amountCents: 1000,
        currency: "USD",
        createdAtMs: 1_700_000_000_000,
        ...overrides,
      },
    })

    beforeEach(() => {
      mockFygaroConfig.credit = { enabled: true }
    })

    // Every state stamped on this delivery, in order. `received` is stamped on
    // every delivery that persists the audit row, so assertions about the
    // TERMINAL answer have to name it rather than counting calls.
    const stampedStates = (): string[] =>
      mockRecordIntentOutcome.mock.calls.map(
        ([args]: [{ outcome: { state: string } }]) => args.outcome.state,
      )
    const terminalStamps = (): string[] =>
      stampedStates().filter((state) => state !== "received")

    it("credits normally when the payment matches what was authorised", async () => {
      mockReadIntent.mockResolvedValue(intent())
      const res = makeRes()

      await paymentHandler(makeReq(SIGNED_BODY), res)

      expect(mockReadIntent).toHaveBeenCalledWith(INTENT_ID)
      // $10.00 gross -> $0.79 processor + $0.20 flash -> $9.01 (901¢) net
      expect(mockCreditFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ recipientAccountId: ACCOUNT_ID, amountCents: 901 }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })

    it("resolves the account from the username half of a username|intentId reference", async () => {
      mockReadIntent.mockResolvedValue(intent())
      const res = makeRes()

      await paymentHandler(makeReq(SIGNED_BODY), res)

      // The whole reference must never reach findByUsername, or a signed
      // checkout would be unattributable and land in the unattributed alert.
      expect(mockFindByUsername).toHaveBeenCalledWith(VALID_BODY.customReference)
      expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: ACCOUNT_ID }),
      )
    })

    it("records-only on an amount mismatch and names both numbers in the alert", async () => {
      // The amount lives inside the signed JWT, so a mismatch cannot come from
      // the customer — it means a bug or a replay on our side, and crediting a
      // payment we cannot account for is the failure this whole change is about.
      mockReadIntent.mockResolvedValue(intent({ amountCents: 2000 }))
      const res = makeRes()

      await paymentHandler(makeReq(SIGNED_BODY), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "warning",
          title:
            "Fygaro payment does not match the checkout Flash signed for it — not auto-credited",
          // Without both numbers the alert says a payment was refused but not
          // what it was refused against — the only thing that tells an operator
          // whether to credit it by hand.
          detail: expect.stringContaining("mismatch=authorised 2000c, paid 1000c"),
          context: expect.objectContaining({
            reason: "intent-mismatch",
            intent_mismatch: "authorised 2000c, paid 1000c",
          }),
        }),
      )
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("records-only on an account mismatch and names both accounts in the alert", async () => {
      mockReadIntent.mockResolvedValue(intent({ accountId: "account-someone-else" }))
      const res = makeRes()

      await paymentHandler(makeReq(SIGNED_BODY), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            reason: "intent-mismatch",
            intent_mismatch: `authorised for account account-someone-else, paid as ${ACCOUNT_ID}`,
          }),
        }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("overrides an otherwise-clean gate: a mismatch is never credited", async () => {
      // The gate can only reason about the payment in front of it, not about
      // whether we ever authorised it, so the mismatch must win outright.
      mockReadIntent.mockResolvedValue(intent({ amountCents: 999 }))
      const res = makeRes()

      await paymentHandler(makeReq(SIGNED_BODY), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "fygaro-recorded",
          meta: expect.objectContaining({ reason: "intent-mismatch" }),
        }),
      )
    })

    it("still credits through the legacy path when the intent is missing or expired", async () => {
      // An intent that expired, was evicted, or was minted by another
      // deployment is NOT a mismatch: it is the position every pre-signed-
      // checkout payment is in, and the credit gate still applies in full.
      // Failing it here would turn a Redis blip into stuck customer funds.
      mockReadIntent.mockResolvedValue({ found: false })
      const res = makeRes()

      await paymentHandler(makeReq(SIGNED_BODY), res)

      expect(mockCreditFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 901 }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })

    it("never looks up an intent for a bare legacy reference", async () => {
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockReadIntent).not.toHaveBeenCalled()
      expect(mockConsumeIntent).not.toHaveBeenCalled()
    })

    // The customer-facing half of this feature. Without these assertions the
    // whole outcome-stamping path could be deleted and every other test here
    // would still pass — which is how a redemption that destroyed the record it
    // stamps shipped: PROCESSING and FAILED were reachable, CREDITED and
    // HELD_FOR_REVIEW were not, and nothing noticed.
    describe("the payment itself is stamped, before any decision about it", () => {
      it("stamps `received` as soon as the audit row is written", async () => {
        // Until this existed the status query could not tell "we have your
        // payment" from "you may never have paid": the intent record is written
        // when the LINK is minted, so a customer whose card was DECLINED polled
        // after the payment page closed and was told their payment had been
        // received and was being credited. This stamp is the server actually
        // knowing.
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            intentId: INTENT_ID,
            outcome: expect.objectContaining({ state: "received" }),
          }),
        )
      })

      it("stamps `received` BEFORE the credit is attempted, not after", async () => {
        // Order is the whole value: stamped after the decision it would tell
        // the customer nothing during the window they are actually staring at
        // the screen.
        mockReadIntent.mockResolvedValue(intent())
        mockCreditFygaroTopup.mockImplementation(async () => {
          expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome: expect.objectContaining({ state: "received" }),
            }),
          )
          return {
            walletId: WALLET_ID,
            walletCurrency: WalletCurrency.Usdt,
            status: "success",
          }
        })

        await paymentHandler(makeReq(SIGNED_BODY), makeRes())

        expect(mockCreditFygaroTopup).toHaveBeenCalledTimes(1)
      })

      it("does not stamp `received` when the audit write failed", async () => {
        // Nothing has been recorded on our side, and the handler answers 500 so
        // Fygaro retries. Claiming receipt off a delivery we could not persist
        // would be the same unbacked claim in a new place.
        mockWriteFygaroTopup.mockResolvedValue(new Error("erpnext down"))
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.status).toHaveBeenCalledWith(500)
        expect(mockRecordIntentOutcome).not.toHaveBeenCalled()
      })
    })

    describe("the terminal outcome is stamped for the app to read", () => {
      it("stamps credited with the NET that actually reached the wallet", async () => {
        // The gross is what the customer paid; the net is what they got. The
        // status screen must report the second, so the second is what is stored.
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            intentId: INTENT_ID,
            outcome: expect.objectContaining({ state: "credited", netAmountCents: 901 }),
          }),
        )
      })

      it("stamps held-for-review with the reason and the REMAINING daily limit", async () => {
        // $100 already charged today against the L1 $125 cap, $30 now. The
        // number sent must be the $25 actually left, not the $125 cap: the
        // sentence built from it reads "more than your REMAINING daily top-up
        // limit of $X", and "$30 is more than your remaining limit of $125.00"
        // is arithmetically false and withholds the only actionable figure.
        mockSumFygaroLast24h.mockResolvedValue(10000)
        mockReadIntent.mockResolvedValue(intent({ amountCents: 3000 }))
        const res = makeRes()

        await paymentHandler(makeReq({ ...SIGNED_BODY, amount: "30.00" }), res)

        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            intentId: INTENT_ID,
            outcome: expect.objectContaining({
              state: "held-for-review",
              reason: "daily-limit-exceeded",
              detailCents: 2500,
            }),
          }),
        )
      })

      it("reports zero remaining rather than a negative one when the cap is already spent", async () => {
        // A hand-credit or a lowered cap can put an account over its limit.
        // "-$25.00 left" is not a thing to show anyone.
        mockSumFygaroLast24h.mockResolvedValue(15000)
        mockReadIntent.mockResolvedValue(intent({ amountCents: 3000 }))
        const res = makeRes()

        await paymentHandler(makeReq({ ...SIGNED_BODY, amount: "30.00" }), res)

        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: expect.objectContaining({
              reason: "daily-limit-exceeded",
              detailCents: 0,
            }),
          }),
        )
      })

      it("stamps the single-payment ceiling for over-limit", async () => {
        mockFindByUsername.mockResolvedValue({ id: ACCOUNT_ID, level: 2 })
        mockReadIntent.mockResolvedValue(intent({ amountCents: 50001 }))
        const res = makeRes()

        await paymentHandler(makeReq({ ...SIGNED_BODY, amount: "500.01" }), res)

        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: expect.objectContaining({
              state: "held-for-review",
              reason: "over-limit",
              detailCents: 50000,
            }),
          }),
        )
      })

      it("stamps the minimum for under-minimum", async () => {
        mockReadIntent.mockResolvedValue(intent({ amountCents: 200 }))
        const res = makeRes()

        await paymentHandler(makeReq({ ...SIGNED_BODY, amount: "2.00" }), res)

        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: expect.objectContaining({
              state: "held-for-review",
              reason: "under-minimum",
              detailCents: 1000,
            }),
          }),
        )
      })

      it("stamps no number for a reason that is ours, not the customer's", async () => {
        // `intent-mismatch` is a bug or a replay on our side. There is no
        // threshold to name, and inventing one would blame the customer for it.
        mockReadIntent.mockResolvedValue(intent({ amountCents: 2000 }))
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: expect.objectContaining({
              state: "held-for-review",
              reason: "intent-mismatch",
              detailCents: undefined,
            }),
          }),
        )
      })

      it("stamps failed (not held) when the credit itself failed", async () => {
        // Retryable, so the app must say "we're on it", not "go to support".
        mockReadIntent.mockResolvedValue(intent())
        mockCreditFygaroTopup.mockResolvedValue(
          new FygaroCreditError("intraledger-send", "some send error"),
        )
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: expect.objectContaining({
              state: "failed",
              reason: "credit-failed",
            }),
          }),
        )
      })

      it("stamps credited on a re-delivery of an already-completed payment", async () => {
        // `recordIntentOutcome` swallows its write failures by design, so a
        // first delivery that credited but failed to stamp leaves every retry
        // short-circuiting on the Completed row. Without a stamp here the
        // customer polls "processing" until the record expires — for money that
        // is already in their wallet.
        //
        // ...and the figure comes off the COMPLETED ROW, not from this
        // delivery's recomputed fees. Here the first delivery credited a
        // fee-discount-whitelisted customer $9.21; this retry's whitelist read
        // fails open to 0% and would recompute $9.01. The store's merge prefers
        // the incoming value, so a recomputed net does not merely fail to
        // improve the record — it OVERWRITES the true one, showing CREDITED
        // $9.01 for $9.21 that is in the wallet.
        mockReadCompletion.mockResolvedValue({ completed: true, netAmountCents: 921 })
        mockGetFlashFeeDiscountPercent.mockResolvedValue(0)
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: expect.objectContaining({ state: "credited", netAmountCents: 921 }),
          }),
        )
        const credited = mockRecordIntentOutcome.mock.calls
          .map(
            ([args]: [{ outcome: { state: string; netAmountCents?: number } }]) => args,
          )
          .filter(({ outcome }) => outcome.state === "credited")
        expect(credited).toHaveLength(1)
        expect(credited[0].outcome.netAmountCents).not.toBe(901)
      })

      it("falls back to this delivery's net when the completed row carries none", async () => {
        // An older row, or one promoted by a path that wrote no fee breakdown.
        // The row is the preferred source, not the only one: with nothing to
        // read back, the recomputed net is better than stamping a credited
        // top-up with no figure at all.
        mockReadCompletion.mockResolvedValue({ completed: true })
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: expect.objectContaining({ state: "credited", netAmountCents: 901 }),
          }),
        )
      })

      it("stamps NO TERMINAL ANSWER on a transient 500 — the payment is not decided yet", async () => {
        // The payment itself IS recorded on this delivery, so `received` is
        // honest and stays. What must never appear is a terminal state: this
        // delivery reached no answer, the provider will retry, and a stamped
        // `held-for-review` would tell the customer a decision was made that
        // the next delivery may well contradict.
        mockSumFygaroLast24h.mockResolvedValue(new Error("erpnext down"))
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.status).toHaveBeenCalledWith(500)
        expect(stampedStates()).toEqual(["received"])
        expect(terminalStamps()).toEqual([])
      })

      it("stamps nothing for a bare legacy reference — there is no record to stamp", async () => {
        const res = makeRes()

        await paymentHandler(makeReq(VALID_BODY), res)

        expect(mockRecordIntentOutcome).not.toHaveBeenCalled()
      })

      it("marks the row uncredited AND stamps the outcome on the record-only path", async () => {
        // Two different readers: ops reads the ERPNext row, the customer reads
        // the intent record. Both must be written, and neither substitutes for
        // the other.
        mockReadIntent.mockResolvedValue(intent({ amountCents: 2000 }))
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(mockMarkNotCredited).toHaveBeenCalledWith(
          expect.objectContaining({
            transactionId: VALID_BODY.transactionId,
            accountId: ACCOUNT_ID,
            reason: "intent-mismatch",
          }),
        )
        // Exactly one TERMINAL stamp — the `received` observation that precedes
        // it is not an answer about the payment and does not count.
        expect(terminalStamps()).toEqual(["held-for-review"])
      })

      it("stamps held-for-review when the record-only dedupe short-circuits", async () => {
        // `recordIntentOutcome` swallows its write failures by design, so a
        // first delivery that took the (non-releasing) record-only timelock and
        // then failed its Redis stamp leaves every retry short-circuiting here.
        // Without a stamp on this return the customer polls PROCESSING until
        // the record expires — for a payment that is permanently held for
        // review. The gate ran on this delivery too, so the same reason and the
        // same number are already in hand.
        mockSumFygaroLast24h.mockResolvedValue(10000)
        mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))
        mockReadIntent.mockResolvedValue(intent({ amountCents: 3000 }))
        const res = makeRes()

        await paymentHandler(makeReq({ ...SIGNED_BODY, amount: "30.00" }), res)

        expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            intentId: INTENT_ID,
            outcome: expect.objectContaining({
              state: "held-for-review",
              reason: "daily-limit-exceeded",
              detailCents: 2500,
            }),
          }),
        )
      })

      it("stamps held-for-review when a signed reference no longer resolves to an account", async () => {
        // The unattributed terminal is terminal: the dedupe lock it takes is
        // non-releasing, so every retry acks already_processed and this is the
        // final answer. Ops credits it by hand; without a stamp the app polls
        // PROCESSING forever while that happens.
        mockFindByUsername.mockResolvedValue(
          new CouldNotFindAccountFromUsernameError(VALID_BODY.customReference),
        )
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.json).toHaveBeenCalledWith({ status: "recorded", attributed: false })
        expect(mockRecordIntentOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            intentId: INTENT_ID,
            outcome: expect.objectContaining({
              state: "held-for-review",
              // Ours, not theirs — the status resolver words it that way.
              reason: "unattributed",
            }),
          }),
        )
      })
    })

    describe("redemption is terminal-only", () => {
      it("redeems the authorisation once the credit has actually gone through", async () => {
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(mockConsumeIntent).toHaveBeenCalledWith(INTENT_ID)
      })

      it("redeems the authorisation on a deterministic record-only ack", async () => {
        // Nothing will change on retry, so the authorisation is spent and its
        // hold on the account's daily allowance must be released.
        mockReadIntent.mockResolvedValue(intent({ amountCents: 2000 }))
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(mockConsumeIntent).toHaveBeenCalledWith(INTENT_ID)
      })

      it("does NOT burn the authorisation on a transient 500 that asks for a retry", async () => {
        // This is the whole reason read and redeem are separate calls. The
        // retry that eventually credits the payment is the delivery most worth
        // verifying; consuming here would leave it with nothing to check.
        mockSumFygaroLast24h.mockResolvedValue(new Error("erpnext down"))
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.status).toHaveBeenCalledWith(500)
        expect(mockConsumeIntent).not.toHaveBeenCalled()
      })

      it("does NOT burn the authorisation when settings are unavailable", async () => {
        mockGetFygaroSettings.mockResolvedValue(undefined)
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.status).toHaveBeenCalledWith(500)
        expect(mockConsumeIntent).not.toHaveBeenCalled()
      })

      it("does NOT burn the authorisation when the credit itself failed", async () => {
        // That branch acks 200 but is deliberately retryable — a failed send is
        // not cached, so the next delivery re-attempts the credit.
        mockReadIntent.mockResolvedValue(intent())
        mockCreditFygaroTopup.mockResolvedValue(
          new FygaroCreditError("intraledger-send", "some send error"),
        )
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
        expect(mockConsumeIntent).not.toHaveBeenCalled()
      })
    })

    // A hold left behind after the payment is already counted in ERPNext is a
    // DOUBLE count: `sumFygaroTopupGrossCentsSince` includes the Fiat Received
    // row the handler just wrote, so the same $50 is subtracted from the daily
    // allowance twice for the rest of the JWT window — refusing the customer's
    // next legitimate top-up on top of an already-bad event.
    describe("the hold is released on terminal answers that did not credit", () => {
      it("releases the reservation — but NOT the record — when the credit failed", async () => {
        mockReadIntent.mockResolvedValue(intent())
        mockCreditFygaroTopup.mockResolvedValue(
          new FygaroCreditError("insufficient-treasury-float", "insufficient balance"),
        )
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(mockReleaseIntentReservation).toHaveBeenCalledWith(
          expect.objectContaining({
            intentId: INTENT_ID,
            accountId: ACCOUNT_ID,
            amountCents: 1000,
          }),
        )
        // The record survives: the manual credit this alert asks for still
        // needs the cross-check of what was originally authorised, and the
        // provider retry this branch invites still needs something to verify
        // against.
        expect(mockConsumeIntent).not.toHaveBeenCalled()
        expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
      })

      it("releases the reservation when a signed reference no longer resolves to an account", async () => {
        // Terminal: the dedupe lock is non-releasing, so Fygaro's retries ack
        // "already_processed" and this delivery is the only one that can let go
        // of the hold.
        mockFindByUsername.mockResolvedValue(
          new CouldNotFindAccountFromUsernameError(VALID_BODY.customReference),
        )
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.json).toHaveBeenCalledWith({ status: "recorded", attributed: false })
        expect(mockReleaseIntentReservation).toHaveBeenCalledWith(
          expect.objectContaining({ intentId: INTENT_ID, amountCents: 1000 }),
        )
        expect(mockConsumeIntent).not.toHaveBeenCalled()
      })

      it("does NOT release the hold on a transient 500 that asks for a retry", async () => {
        // The retry will re-run this handler and reach a terminal answer that
        // releases it. Letting go early would let a second link be minted
        // against an allowance this payment has already consumed.
        mockSumFygaroLast24h.mockResolvedValue(new Error("erpnext down"))
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.status).toHaveBeenCalledWith(500)
        expect(mockReleaseIntentReservation).not.toHaveBeenCalled()
        expect(mockConsumeIntent).not.toHaveBeenCalled()
      })

      it("leaves the release to consumeIntent on a successful credit", async () => {
        // consumeIntent releases the hold itself once it wins the claim, so
        // releasing here as well would be a second, redundant zrem.
        mockReadIntent.mockResolvedValue(intent())
        const res = makeRes()

        await paymentHandler(makeReq(SIGNED_BODY), res)

        expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
        expect(mockConsumeIntent).toHaveBeenCalledWith(INTENT_ID)
        expect(mockReleaseIntentReservation).not.toHaveBeenCalled()
      })
    })
  })
})
