const mockRecordInternalTransferInvoice = jest.fn()
jest.mock("@services/mongoose/internal-transfer-invoices", () => ({
  recordInternalTransferInvoice: (...args: unknown[]) =>
    mockRecordInternalTransferInvoice(...args),
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

import {
  markOutgoingBolt11,
  markPaidLnurlHash,
} from "@app/payments/mark-outgoing-invoice"
import { RepositoryError } from "@domain/errors"
import { InternalTransferMarkerError } from "@domain/payment-splits"

// BOLT11 spec test vector; its payment hash is 0001…0102.
const BOLT11 =
  "lnbc20u1pvjluezhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfppqw508d6qejxtdg4y5r3zarvary0c5xw7kxqrrsssp5m6kmam774klwlh4dhmhaatd7al02m0h0m6kmam774klwlh4dhmhs9qypqqqcqpf3cwux5979a8j28d4ydwahx00saa68wq3az7v9jdgzkghtxnkf3z5t7q5suyq2dl9tqwsap8j0wptc82cpyvey9gf6zyylzrm60qtcqsq7egtsq"
const HASH = "0001020304050607080900010203040506070809000102030405060708090102"
const SENDER = "sender-wallet" as WalletId

beforeEach(() => {
  jest.clearAllMocks()
  mockRecordInternalTransferInvoice.mockResolvedValue(true)
})

describe("markOutgoingBolt11", () => {
  it("marks the bolt11's payment hash as an ln-send from the paying wallet", async () => {
    expect(
      await markOutgoingBolt11({ paymentRequest: BOLT11, senderWalletId: SENDER }),
    ).toBe(true)
    expect(mockRecordInternalTransferInvoice).toHaveBeenCalledWith({
      paymentHash: HASH,
      senderWalletId: SENDER,
      origin: "ln-send",
    })
  })

  it("fails closed when the marker cannot be written", async () => {
    mockRecordInternalTransferInvoice.mockResolvedValue(new RepositoryError("mongo"))

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
    expect(mockRecordInternalTransferInvoice).not.toHaveBeenCalled()
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
