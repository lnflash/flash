import {
  createCashWalletMigrationFeeReimbursementInvoice,
  isSubMinimumFeeReimbursementAmount,
  sendCashWalletMigrationFeeReimbursementPayment,
  skipCashWalletMigrationFeeReimbursement,
} from "@app/cash-wallet-cutover/worker"

const migration = {
  id: "migration-id",
  accountId: "account-id" as AccountId,
  legacyUsdWalletId: "legacy-wallet-id" as WalletId,
  destinationUsdtWalletId: "destination-wallet-id" as WalletId,
  cutoverVersion: 3,
  runId: "run-id",
  status: "balance_move_verified",
  idempotencyKey: "run-id:account-id",
  attempts: 0,
  updatedAt: new Date("2026-06-29T00:00:00.000Z"),
} as CashWalletMigration

const invoice = {
  paymentRequest: "lnbc1invoice" as Bolt11,
  paymentHash: "payment-hash" as PaymentHash,
}

const transitionRepo = () => ({
  transitionMigration: jest.fn(async ({ to, patch }) => ({
    ...migration,
    ...patch,
    status: to,
  })),
})

describe("cash wallet migration worker fee reimbursement", () => {
  it("uses a no-amount invoice for sub-cent USDT reimbursements", async () => {
    const migrationsRepo = transitionRepo()
    const invoiceService = {
      createInvoice: jest.fn(),
      createNoAmountInvoice: jest.fn().mockResolvedValue(invoice),
    }

    const result = await createCashWalletMigrationFeeReimbursementInvoice({
      migration,
      migrationsRepo,
      invoiceService,
      feeAmountUsdtMicros: "4735",
    })

    expect(result).toEqual({
      ...migration,
      status: "fee_reimbursement_invoice_created",
      feeAmountUsdCents: "1",
      feeAmountUsdtMicros: "4735",
      feeReimbursementInvoicePaymentRequest: invoice.paymentRequest,
      feeReimbursementInvoicePaymentHash: invoice.paymentHash,
    })
    expect(invoiceService.createNoAmountInvoice).toHaveBeenCalledWith({
      recipientWalletId: migration.destinationUsdtWalletId,
      memo: `cwco:${migration.runId}:${migration.id}:fee`,
    })
    expect(invoiceService.createInvoice).not.toHaveBeenCalled()
  })

  it("pays sub-cent reimbursement invoices with the exact USDT amount", async () => {
    const migrationsRepo = transitionRepo()
    const paymentService = {
      payInvoice: jest.fn().mockResolvedValue({
        transactionId: "fee-transaction-id" as IbexTransactionId,
      }),
    }

    const result = await sendCashWalletMigrationFeeReimbursementPayment({
      migration: {
        ...migration,
        status: "fee_reimbursement_invoice_created",
        feeAmountUsdtMicros: "4735",
        feeReimbursementInvoicePaymentRequest: invoice.paymentRequest,
      } as CashWalletMigration,
      treasuryWalletId: "treasury-wallet-id" as WalletId,
      migrationsRepo,
      paymentService,
    })

    expect(result).toEqual({
      ...migration,
      status: "fee_reimbursement_sending",
      feeReimbursementPaymentTransactionId: "fee-transaction-id",
    })
    expect(paymentService.payInvoice).toHaveBeenCalledWith({
      senderWalletId: "treasury-wallet-id",
      paymentRequest: invoice.paymentRequest,
      senderAmountUsdtMicros: "4735",
    })
  })

  it("classifies sub-cent fees as sub-minimum (absorbed, never paid)", () => {
    expect(isSubMinimumFeeReimbursementAmount("0")).toBe(true)
    expect(isSubMinimumFeeReimbursementAmount("515")).toBe(true) // rehearsal dust
    expect(isSubMinimumFeeReimbursementAmount("9999")).toBe(true)
    expect(isSubMinimumFeeReimbursementAmount("10000")).toBe(false)
    expect(isSubMinimumFeeReimbursementAmount("-1")).toBeInstanceOf(Error)
  })

  it("records the absorbed micros when skipping a dust fee (ENG-484)", async () => {
    const migrationsRepo = transitionRepo()

    const result = await skipCashWalletMigrationFeeReimbursement({
      migration,
      migrationsRepo,
      feeAmountUsdtMicros: "515",
    })

    expect(result).toEqual({
      ...migration,
      status: "fee_reimbursed",
      feeAmountUsdCents: "0",
      feeAmountUsdtMicros: "515",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "fee_reimbursed",
        patch: { feeAmountUsdCents: "0", feeAmountUsdtMicros: "515" },
      }),
    )
  })
})
