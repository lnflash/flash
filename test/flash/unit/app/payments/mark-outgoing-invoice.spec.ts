const mockRecordInternalTransferInvoice = jest.fn()
const mockInsertInternalTransferInvoice = jest.fn()
const mockDeleteInternalTransferInvoice = jest.fn()
const mockIsInternalTransferInvoice = jest.fn()
jest.mock("@services/mongoose/internal-transfer-invoices", () => ({
  recordInternalTransferInvoice: (...args: unknown[]) =>
    mockRecordInternalTransferInvoice(...args),
  insertInternalTransferInvoice: (...args: unknown[]) =>
    mockInsertInternalTransferInvoice(...args),
  deleteInternalTransferInvoice: (...args: unknown[]) =>
    mockDeleteInternalTransferInvoice(...args),
  isInternalTransferInvoice: (...args: unknown[]) =>
    mockIsInternalTransferInvoice(...args),
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { isInternalTransferInvoice } from "@services/mongoose/internal-transfer-invoices"
import {
  isDefinitivePaymentRejection,
  markOutgoingBolt11,
  markPaidLnurlHash,
  payMarkedBolt11,
} from "@app/payments/mark-outgoing-invoice"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { RepositoryError } from "@domain/errors"
import { InternalTransferMarkerError } from "@domain/payment-splits"
import { ErrorLevel } from "@domain/shared"
import {
  CompletedInvoice,
  FailedIbexPayment,
  IbexError,
  InsufficientIbexBalance,
  UnconfirmedIbexPayment,
} from "@services/ibex/errors"

// BOLT11 spec test vector; its payment hash is 0001…0102.
const BOLT11 =
  "lnbc20u1pvjluezhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfppqw508d6qejxtdg4y5r3zarvary0c5xw7kxqrrsssp5m6kmam774klwlh4dhmhaatd7al02m0h0m6kmam774klwlh4dhmhs9qypqqqcqpf3cwux5979a8j28d4ydwahx00saa68wq3az7v9jdgzkghtxnkf3z5t7q5suyq2dl9tqwsap8j0wptc82cpyvey9gf6zyylzrm60qtcqsq7egtsq"
const HASH = "0001020304050607080900010203040506070809000102030405060708090102"
const SENDER = "sender-wallet" as WalletId

beforeEach(() => {
  jest.clearAllMocks()
  mockRecordInternalTransferInvoice.mockResolvedValue(true)
  mockInsertInternalTransferInvoice.mockResolvedValue({ created: true })
  mockDeleteInternalTransferInvoice.mockResolvedValue(true)
})

describe("markOutgoingBolt11", () => {
  it("marks the bolt11's payment hash as an ln-send from the paying wallet", async () => {
    expect(
      await markOutgoingBolt11({ paymentRequest: BOLT11, senderWalletId: SENDER }),
    ).toBe(true)
    expect(mockInsertInternalTransferInvoice).toHaveBeenCalledWith({
      paymentHash: HASH,
      senderWalletId: SENDER,
      origin: "ln-send",
    })
  })

  it("fails closed when the marker cannot be written", async () => {
    mockInsertInternalTransferInvoice.mockResolvedValue(new RepositoryError("mongo"))

    expect(
      await markOutgoingBolt11({ paymentRequest: BOLT11, senderWalletId: SENDER }),
    ).toBeInstanceOf(InternalTransferMarkerError)
  })

  it("lets an undecodable request through unmarked (IBEX-minted invoices always decode)", async () => {
    expect(
      await markOutgoingBolt11({
        paymentRequest: "lnbc1garbage",
        senderWalletId: SENDER,
      }),
    ).toBe(true)
    expect(mockInsertInternalTransferInvoice).not.toHaveBeenCalled()
  })
})

describe("markPaidLnurlHash", () => {
  it("marks the paid hash as an lnurl-send", async () => {
    await markPaidLnurlHash({ paymentHash: HASH, senderWalletId: SENDER })

    expect(mockRecordInternalTransferInvoice).toHaveBeenCalledWith({
      paymentHash: HASH,
      senderWalletId: SENDER,
      origin: "lnurl-send",
    })
  })

  it.each([undefined, null, "not-a-hash"])(
    "ignores a missing or malformed hash (%p)",
    async (paymentHash) => {
      await markPaidLnurlHash({ paymentHash, senderWalletId: SENDER })
      expect(mockRecordInternalTransferInvoice).not.toHaveBeenCalled()
    },
  )

  it("never throws after the money moved, even if the write fails", async () => {
    mockRecordInternalTransferInvoice.mockResolvedValue(new RepositoryError("mongo"))

    await expect(
      markPaidLnurlHash({ paymentHash: HASH, senderWalletId: SENDER }),
    ).resolves.toBeUndefined()
  })
})

const httpError = (httpCode: number) => {
  const err = new IbexError(new Error(`IBEX ${httpCode}`))
  Object.defineProperty(err, "httpCode", { value: httpCode })
  return err
}

describe("isDefinitivePaymentRejection", () => {
  it.each([
    [
      "insufficient balance",
      new InsufficientIbexBalance(new Error("400"), ErrorLevel.Info),
    ],
    ["a corroborated FAILED response", new FailedIbexPayment("failed")],
    ["a FAILED status", PaymentSendStatus.Failure],
    ["an IBEX 400 (no route, expired)", httpError(400)],
    ["an IBEX 429", httpError(429)],
  ])("is true for %s", (_label, result) => {
    expect(isDefinitivePaymentRejection(result)).toBe(true)
  })

  it.each([
    ["success", PaymentSendStatus.Success],
    ["pending", PaymentSendStatus.Pending],
    ["an unreadable response", new UnconfirmedIbexPayment("unreadable")],
    ["an already-paid invoice", new CompletedInvoice(new Error("400"))],
    ["an IBEX 5xx", httpError(502)],
    ["a request timeout", httpError(408)],
    ["a transport error with no status", new IbexError(new Error("ECONNRESET"))],
    ["a non-IBEX error", new Error("lock")],
  ])("is false for %s", (_label, result) => {
    expect(isDefinitivePaymentRejection(result)).toBe(false)
  })
})

describe("payMarkedBolt11", () => {
  const run = (result: unknown) =>
    payMarkedBolt11({
      paymentRequest: BOLT11,
      senderWalletId: SENDER,
      pay: async () => result,
    })

  it("marks before paying and keeps the marker when the payment succeeds", async () => {
    const order: string[] = []
    mockInsertInternalTransferInvoice.mockImplementation(async () => {
      order.push("mark")
      return { created: true }
    })

    const result = await payMarkedBolt11({
      paymentRequest: BOLT11,
      senderWalletId: SENDER,
      pay: async () => {
        order.push("pay")
        return PaymentSendStatus.Success
      },
    })

    expect(result).toBe(PaymentSendStatus.Success)
    expect(order).toEqual(["mark", "pay"])
    expect(mockDeleteInternalTransferInvoice).not.toHaveBeenCalled()
  })

  it("keeps the marker while the payment is pending", async () => {
    expect(await run(PaymentSendStatus.Pending)).toBe(PaymentSendStatus.Pending)
    expect(mockDeleteInternalTransferInvoice).not.toHaveBeenCalled()
  })

  it("withdraws its own marker when IBEX rejects the payment outright", async () => {
    const rejected = new InsufficientIbexBalance(new Error("400"), ErrorLevel.Info)

    expect(await run(rejected)).toBe(rejected)
    expect(mockDeleteInternalTransferInvoice).toHaveBeenCalledWith({
      paymentHash: HASH,
      senderWalletId: SENDER,
      origin: "ln-send",
    })
  })

  it("leaves a marker it did not create, even on a rejection", async () => {
    mockInsertInternalTransferInvoice.mockResolvedValue({ created: false })

    await run(PaymentSendStatus.Failure)

    expect(mockDeleteInternalTransferInvoice).not.toHaveBeenCalled()
  })

  it("pays nothing when the marker cannot be written", async () => {
    mockInsertInternalTransferInvoice.mockResolvedValue(new RepositoryError("mongo"))
    const pay = jest.fn()

    const result = await payMarkedBolt11({
      paymentRequest: BOLT11,
      senderWalletId: SENDER,
      pay,
    })

    expect(result).toBeInstanceOf(InternalTransferMarkerError)
    expect(pay).not.toHaveBeenCalled()
  })

  it("still returns the payment result when the withdrawal fails", async () => {
    mockDeleteInternalTransferInvoice.mockResolvedValue(new RepositoryError("mongo"))

    expect(await run(PaymentSendStatus.Failure)).toBe(PaymentSendStatus.Failure)
  })
})

describe("payMarkedBolt11 with two Flash payers of the same bolt11", () => {
  // In-memory stand-in for the marker collection with its real uniqueness:
  // one row per (hash, sender, origin); a hash is internal while any row exists.
  const rows = new Set<string>()
  const key = (a: { paymentHash: string; senderWalletId?: string; origin: string }) =>
    [a.paymentHash.toLowerCase(), a.senderWalletId ?? "", a.origin].join("|")

  beforeEach(() => {
    rows.clear()
    mockInsertInternalTransferInvoice.mockImplementation(async (a) => {
      if (rows.has(key(a))) return { created: false }
      rows.add(key(a))
      return { created: true }
    })
    mockDeleteInternalTransferInvoice.mockImplementation(async (a) => rows.delete(key(a)))
    mockIsInternalTransferInvoice.mockImplementation(async (hash: string) =>
      [...rows].some((r) => r.startsWith(`${hash.toLowerCase()}|`)),
    )
  })

  it("keeps the hash internal when A is rejected with a 400 after B marked it too", async () => {
    const SENDER_A = "sender-a" as WalletId
    const SENDER_B = "sender-b" as WalletId
    const rejected = new IbexError(new Error("Bad Request"))
    Object.defineProperty(rejected, "httpCode", { value: 400 })

    // Both mark before either payment returns; A's is then rejected, B's settles.
    let releaseA: () => void = () => undefined
    const aPaid = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const payA = payMarkedBolt11({
      paymentRequest: BOLT11,
      senderWalletId: SENDER_A,
      pay: async () => {
        await aPaid
        return rejected
      },
    })
    const payB = payMarkedBolt11({
      paymentRequest: BOLT11,
      senderWalletId: SENDER_B,
      pay: async () => {
        releaseA()
        return PaymentSendStatus.Success
      },
    })

    expect(await payB).toBe(PaymentSendStatus.Success)
    expect(await payA).toBe(rejected)

    expect(mockDeleteInternalTransferInvoice).toHaveBeenCalledTimes(1)
    expect(mockDeleteInternalTransferInvoice).toHaveBeenCalledWith({
      paymentHash: HASH,
      senderWalletId: SENDER_A,
      origin: "ln-send",
    })
    expect(rows).toEqual(new Set([`${HASH}|${SENDER_B}|ln-send`]))
    expect(await isInternalTransferInvoice(HASH)).toBe(true)
  })
})
