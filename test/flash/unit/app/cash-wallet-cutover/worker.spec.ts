import { CouldNotUpdateError } from "@domain/errors"

import {
  createCashWalletMigrationBalanceMoveInvoice,
  recordCashWalletMigrationBalance,
  sendCashWalletMigrationBalanceMovePayment,
  startCashWalletMigration,
} from "@app/cash-wallet-cutover/worker"

const migration = (status: CashWalletMigrationStatus): CashWalletMigration => ({
  id: "migration-id",
  accountId: "account-id" as AccountId,
  legacyUsdWalletId: "legacy-usd-wallet-id" as WalletId,
  destinationUsdtWalletId: "usdt-wallet-id" as WalletId,
  cutoverVersion: 7,
  runId: "run-7",
  status,
  idempotencyKey: "cash-wallet-cutover:run-7:account-id",
  attempts: 0,
  updatedAt: new Date("2026-05-20T00:00:00Z"),
})

describe("cash wallet migration worker checkpoints", () => {
  it("starts a not-started migration with an atomic repository transition", async () => {
    const startedAt = new Date("2026-05-20T13:00:00Z")
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => migration("started")),
    }

    const result = await startCashWalletMigration({
      migration: migration("not_started"),
      migrationsRepo,
      startedAt,
    })

    expect(result).toMatchObject({ status: "started" })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "not_started",
      to: "started",
      cutoverVersion: 7,
      runId: "run-7",
      patch: { startedAt },
    })
  })

  it("rejects invalid start transitions before touching the repository", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }

    const result = await startCashWalletMigration({
      migration: migration("balance_read"),
      migrationsRepo,
      startedAt: new Date("2026-05-20T13:00:00Z"),
    })

    expect(result).toBeInstanceOf(Error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("returns repository transition failures", async () => {
    const error = new CouldNotUpdateError("transition failed")
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => error),
    }

    const result = await startCashWalletMigration({
      migration: migration("not_started"),
      migrationsRepo,
      startedAt: new Date("2026-05-20T13:00:00Z"),
    })

    expect(result).toBe(error)
  })

  it("records source balance and destination amount before creating invoices", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("balance_read"),
        sourceBalanceUsdCents: "1234",
        destinationAmountUsdtMicros: "12340000",
      })),
    }

    const result = await recordCashWalletMigrationBalance({
      migration: migration("provisioned"),
      migrationsRepo,
      sourceBalanceUsdCents: "1234",
    })

    expect(result).toMatchObject({
      status: "balance_read",
      sourceBalanceUsdCents: "1234",
      destinationAmountUsdtMicros: "12340000",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "provisioned",
      to: "balance_read",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        sourceBalanceUsdCents: "1234",
        destinationAmountUsdtMicros: "12340000",
      },
    })
  })

  it("rejects invalid balance amounts before touching the repository", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }

    const result = await recordCashWalletMigrationBalance({
      migration: migration("provisioned"),
      migrationsRepo,
      sourceBalanceUsdCents: "12.34",
    })

    expect(result).toBeInstanceOf(Error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("creates a balance move invoice on the destination wallet", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("invoice_created"),
        balanceMoveInvoicePaymentRequest: "lnbc1balance-move",
        balanceMoveInvoicePaymentHash: "paymentHash",
      })),
    }
    const invoice = {
      paymentRequest: "lnbc1balance-move" as EncodedPaymentRequest,
      paymentHash: "paymentHash" as PaymentHash,
    } as LnInvoice
    const invoiceService = {
      createInvoice: jest.fn(async () => invoice),
    }

    const result = await createCashWalletMigrationBalanceMoveInvoice({
      migration: {
        ...migration("balance_read"),
        destinationAmountUsdtMicros: "12340000",
      },
      invoiceService,
      migrationsRepo,
    })

    expect(result).toMatchObject({
      status: "invoice_created",
      balanceMoveInvoicePaymentRequest: "lnbc1balance-move",
      balanceMoveInvoicePaymentHash: "paymentHash",
    })
    expect(invoiceService.createInvoice).toHaveBeenCalledWith({
      recipientWalletId: "usdt-wallet-id",
      amount: "12340000",
      memo: "cash-wallet-cutover:run-7:migration-id:balance-move",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "balance_read",
      to: "invoice_created",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        balanceMoveInvoicePaymentRequest: "lnbc1balance-move",
        balanceMoveInvoicePaymentHash: "paymentHash",
      },
    })
  })

  it("rejects balance move invoice creation when the destination amount is missing", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const invoiceService = {
      createInvoice: jest.fn(),
    }

    const result = await createCashWalletMigrationBalanceMoveInvoice({
      migration: migration("balance_read"),
      invoiceService,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(Error)
    expect(invoiceService.createInvoice).not.toHaveBeenCalled()
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("returns balance move invoice creation failures without advancing the checkpoint", async () => {
    const error = new CouldNotUpdateError("invoice creation failed")
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const invoiceService = {
      createInvoice: jest.fn(async () => error),
    }

    const result = await createCashWalletMigrationBalanceMoveInvoice({
      migration: {
        ...migration("balance_read"),
        destinationAmountUsdtMicros: "12340000",
      },
      invoiceService,
      migrationsRepo,
    })

    expect(result).toBe(error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("sends the balance move payment from the legacy wallet", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("balance_move_sending"),
        balanceMovePaymentTransactionId: "ibex-tx-id",
      })),
    }
    const paymentService = {
      payInvoice: jest.fn(async () => ({
        transactionId: "ibex-tx-id" as IbexTransactionId,
      })),
    }

    const result = await sendCashWalletMigrationBalanceMovePayment({
      migration: {
        ...migration("invoice_created"),
        balanceMoveInvoicePaymentRequest: "lnbc1balance-move",
      },
      paymentService,
      migrationsRepo,
    })

    expect(result).toMatchObject({
      status: "balance_move_sending",
      balanceMovePaymentTransactionId: "ibex-tx-id",
    })
    expect(paymentService.payInvoice).toHaveBeenCalledWith({
      senderWalletId: "legacy-usd-wallet-id",
      paymentRequest: "lnbc1balance-move",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "invoice_created",
      to: "balance_move_sending",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        balanceMovePaymentTransactionId: "ibex-tx-id",
      },
    })
  })

  it("rejects balance move payment sending when the invoice payment request is missing", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const paymentService = {
      payInvoice: jest.fn(),
    }

    const result = await sendCashWalletMigrationBalanceMovePayment({
      migration: migration("invoice_created"),
      paymentService,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(Error)
    expect(paymentService.payInvoice).not.toHaveBeenCalled()
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })
})
