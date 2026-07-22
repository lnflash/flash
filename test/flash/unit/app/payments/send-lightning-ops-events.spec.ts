const mockFindWalletById = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@config", () => ({
  getCallbackServiceConfig: jest.fn(() => ({})),
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/lnd", () => ({
  LndService: jest.fn(() => ({})),
}))

jest.mock("@services/mongoose", () => ({
  LnPaymentsRepository: jest.fn(() => ({})),
  PaymentFlowStateRepository: jest.fn(() => ({})),
  WalletInvoicesRepository: jest.fn(() => ({})),
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
  UsersRepository: jest.fn(() => ({})),
  AccountsRepository: jest.fn(() => ({})),
}))

jest.mock("@services/dealer-price", () => ({
  DealerPriceService: jest.fn(() => ({})),
}))

jest.mock("@services/ledger", () => ({
  LedgerService: jest.fn(() => ({})),
}))

jest.mock("@services/ledger/facade", () => ({}))

jest.mock("@services/lock", () => ({
  LockService: jest.fn(() => ({})),
}))

jest.mock("@services/notifications", () => ({
  NotificationsService: jest.fn(() => ({})),
}))

jest.mock("@services/svix", () => ({
  CallbackService: jest.fn(() => ({})),
}))

jest.mock("@app/prices", () => ({
  getCurrentPriceAsDisplayPriceRatio: jest.fn(),
}))

jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: jest.fn(),
}))

jest.mock("@app/wallets", () => ({
  validateIsBtcWallet: jest.fn(),
  validateIsUsdWallet: jest.fn(),
}))

jest.mock("@app/payments/helpers", () => ({
  addContactsAfterSend: jest.fn(),
  checkIntraledgerLimits: jest.fn(),
  checkTradeIntraAccountLimits: jest.fn(),
  checkWithdrawalLimits: jest.fn(),
  constructPaymentFlowBuilder: jest.fn(),
  getPriceRatioForLimits: jest.fn(),
}))

jest.mock("@app/payments/reimburse-fee", () => ({
  reimburseFee: jest.fn(),
}))

jest.mock("@domain/bitcoin/lightning", () => {
  const actual = jest.requireActual("@domain/bitcoin/lightning")
  return {
    ...actual,
    decodeInvoice: jest.fn(() => ({
      destination: "dest-pubkey",
      paymentHash: "a".repeat(64),
      description: "test invoice",
      expiresAt: new Date(Date.now() + 600_000),
      paymentAmount: { amount: 1000n, currency: "BTC" },
    })),
  }
})

import { payInvoiceByWalletId } from "@app/payments/send-lightning"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { AlreadyPaidError } from "@domain/errors"
import { notifyOpsEvent } from "@services/alerts/ops-events"

const senderWalletId = "11111111-1111-4111-8111-111111111111" as WalletId
const invalidWalletId = "not-a-wallet-id" as WalletId
const senderAccount = {
  id: "64df1a2b3c4d5e6f78901234",
  displayCurrency: "USD",
} as unknown as Account

describe("ops events — payInvoiceByWalletId", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("notifies a succeeded transfer event on a non-error outcome", async () => {
    // AlreadyPaid resolves to PaymentSendStatus.AlreadyPaid — a successful outcome
    mockFindWalletById.mockResolvedValue(new AlreadyPaidError())

    const result = await payInvoiceByWalletId({
      uncheckedPaymentRequest: "lnbc1...",
      memo: null,
      senderWalletId,
      senderAccount,
    })

    expect(result).toBe(PaymentSendStatus.AlreadyPaid)
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        phase: "succeeded",
        status: "success",
        accountId: senderAccount.id,
        meta: { senderWalletId },
      }),
    )
  })

  it("notifies a failed transfer event with the error name on error return", async () => {
    const result = await payInvoiceByWalletId({
      uncheckedPaymentRequest: "lnbc1...",
      memo: null,
      senderWalletId: invalidWalletId,
      senderAccount,
    })

    expect(result).toBeInstanceOf(Error)
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        phase: "failed",
        status: "failed",
        accountId: senderAccount.id,
        error: (result as Error).constructor.name,
        meta: { senderWalletId: invalidWalletId },
      }),
    )
  })
})
