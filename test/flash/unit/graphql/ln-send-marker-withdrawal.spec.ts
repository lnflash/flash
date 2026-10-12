// ENG-653 review: a Flash user's rejected attempt to pay a merchant's bolt11
// must not leave the ln-send marker behind. If it did, the merchant's splits
// would be skipped as Flash-to-Flash when a wallet outside Flash paid the same
// invoice afterwards. This spec runs both bolt11 send resolvers against the real
// marker helper and the real split recorder, with the marker collection and
// the split stores held in memory.

const markers = new Map<string, { senderWalletId?: string; origin: string }>()
jest.mock("@services/mongoose/internal-transfer-invoices", () => ({
  insertInternalTransferInvoice: async (args: {
    paymentHash: string
    senderWalletId?: string
    origin: string
  }) => {
    const key = args.paymentHash.toLowerCase()
    if (markers.has(key)) return { created: false }
    markers.set(key, { senderWalletId: args.senderWalletId, origin: args.origin })
    return { created: true }
  },
  recordInternalTransferInvoice: async () => true,
  deleteInternalTransferInvoice: async (args: {
    paymentHash: string
    senderWalletId: string
    origin: string
  }) => {
    const key = args.paymentHash.toLowerCase()
    const found = markers.get(key)
    if (!found) return false
    if (found.senderWalletId !== args.senderWalletId || found.origin !== args.origin) {
      return false
    }
    return markers.delete(key)
  },
  isInternalTransferInvoice: async (paymentHash: string) =>
    markers.has(paymentHash.toLowerCase()),
}))

const mockListRules = jest.fn()
jest.mock("@services/mongoose/payment-split-rules", () => ({
  PaymentSplitRulesRepository: jest.fn(() => ({
    listByWalletId: (...args: unknown[]) => mockListRules(...args),
  })),
}))
jest.mock("@services/mongoose/payment-split-executions", () => ({
  PaymentSplitExecutionsRepository: jest.fn(() => mockStore.repo),
}))

jest.mock("@app/payments/authorize-send", () => ({
  authorizeSend: async () => true,
  gateSend: async () => true,
  SendRejectionReasons: { undecodableInvoice: "undecodable-invoice" },
}))

jest.mock("@app/payments/idempotency", () => ({
  withPaymentIdempotency: async ({
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
}))

jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletMutationWalletIdForAccount: async ({
    walletId,
  }: {
    walletId: string
  }) => walletId,
}))

jest.mock("@app/wallets", () => ({
  usdWalletAmountFromWalletId: async () => ({ toIbex: () => 50 }),
}))

const mockPayInvoice = jest.fn()
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { payInvoice: (...args: unknown[]) => mockPayInvoice(...args) },
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  addEventToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { PaymentSplitsConfig } from "@config"
import { recordSplitExecutions } from "@app/payment-splits/record-split-executions"
import { ErrorLevel, WalletCurrency } from "@domain/shared"
import LnInvoicePaymentSendMutation from "@graphql/public/root/mutation/ln-invoice-payment-send"
import LnNoAmountUsdInvoicePaymentSendMutation from "@graphql/public/root/mutation/ln-noamount-usd-invoice-payment-send"
import { IbexError, InsufficientIbexBalance } from "@services/ibex/errors"

import { createFakeExecutionsStore } from "../app/payment-splits/fake-executions-store"

const mockStore = createFakeExecutionsStore()

// BOLT11 spec test vector; its payment hash is 0001…0102.
const BOLT11 =
  "lnbc20u1pvjluezhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfppqw508d6qejxtdg4y5r3zarvary0c5xw7kxqrrsssp5m6kmam774klwlh4dhmhaatd7al02m0h0m6kmam774klwlh4dhmhs9qypqqqcqpf3cwux5979a8j28d4ydwahx00saa68wq3az7v9jdgzkghtxnkf3z5t7q5suyq2dl9tqwsap8j0wptc82cpyvey9gf6zyylzrm60qtcqsq7egtsq"
const HASH = "0001020304050607080900010203040506070809000102030405060708090102"
const PAYER_WALLET = "flash-payer-wallet"
const MERCHANT_WALLET = "merchant-wallet"

type Resolve = (
  source: null,
  args: { input: Record<string, unknown> },
  ctx: { domainAccount: Record<string, unknown> },
) => Promise<{ status?: string; errors: { message: string }[] }>

const resolvers: [string, () => ReturnType<Resolve>][] = [
  [
    "lnInvoicePaymentSend",
    () =>
      (LnInvoicePaymentSendMutation.resolve as unknown as Resolve)(
        null,
        { input: { walletId: PAYER_WALLET, paymentRequest: BOLT11 } },
        { domainAccount: { id: "payer-account" } },
      ),
  ],
  [
    "lnNoAmountUsdInvoicePaymentSend",
    () =>
      (LnNoAmountUsdInvoicePaymentSendMutation.resolve as unknown as Resolve)(
        null,
        { input: { walletId: PAYER_WALLET, paymentRequest: BOLT11, amount: 5000 } },
        { domainAccount: { id: "payer-account" } },
      ),
  ],
]

// The merchant's wallet receives the invoice later, from a wallet outside
// Flash (the IBEX on-receive webhook calls the recorder with the hash).
const merchantReceives = () =>
  recordSplitExecutions({
    walletId: MERCHANT_WALLET,
    triggerKey: HASH,
    paymentHash: HASH,
    amount: 50,
    currency: WalletCurrency.Usdt,
  })

const originalEnabled = PaymentSplitsConfig.enabled

beforeEach(() => {
  jest.clearAllMocks()
  markers.clear()
  mockStore.rows.clear()
  PaymentSplitsConfig.enabled = true
  mockListRules.mockResolvedValue([
    {
      id: "rule-1",
      walletId: MERCHANT_WALLET,
      destinationWalletId: "partner-wallet",
      percent: 10,
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ])
})

afterAll(() => {
  PaymentSplitsConfig.enabled = originalEnabled
})

describe.each(resolvers)("%s ln-send marker (ENG-653)", (_name, pay) => {
  it("withdraws the marker when IBEX rejects for insufficient balance, so a later external payment records splits", async () => {
    mockPayInvoice.mockResolvedValue(
      new InsufficientIbexBalance(new Error("Bad Request"), ErrorLevel.Info),
    )

    const result = await pay()

    expect(result.status).toBe("failed")
    expect(markers.has(HASH)).toBe(false)
    expect(await merchantReceives()).toEqual({
      recorded: 1,
      duplicates: 0,
      skippedMin: 0,
    })
  })

  it("withdraws the marker on an IBEX 4xx rejection (no route, expired)", async () => {
    const rejected = new IbexError(new Error("no route"))
    Object.defineProperty(rejected, "httpCode", { value: 400 })
    mockPayInvoice.mockResolvedValue(rejected)

    await pay()

    expect(markers.has(HASH)).toBe(false)
  })

  it("keeps the marker when the payment settles, so the payee's splits do not fire", async () => {
    mockPayInvoice.mockResolvedValue({ transaction: { payment: { status: { id: 2 } } } })

    expect((await pay()).status).toBe("success")
    expect(markers.has(HASH)).toBe(true)
    expect(await merchantReceives()).toEqual({
      recorded: 0,
      duplicates: 0,
      skippedMin: 0,
    })
  })

  it("keeps the marker when the outcome is unknown (transport error)", async () => {
    mockPayInvoice.mockResolvedValue(new IbexError(new Error("ECONNRESET")))

    await pay()

    expect(markers.has(HASH)).toBe(true)
  })

  it("keeps the marker while the payment is in flight", async () => {
    mockPayInvoice.mockResolvedValue({ transaction: { payment: { status: { id: 1 } } } })

    expect((await pay()).status).toBe("pending")
    expect(markers.has(HASH)).toBe(true)
  })
})
