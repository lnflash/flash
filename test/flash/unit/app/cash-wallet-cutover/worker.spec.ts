import { CouldNotUpdateError } from "@domain/errors"

import {
  createCashWalletMigrationBalanceMoveInvoice,
  createCashWalletMigrationFeeReimbursementInvoice,
  flipCashWalletMigrationDefaultPointer,
  completeCashWalletMigration,
  markCashWalletMigrationFeeReimbursed,
  markCashWalletMigrationBalanceMoveSent,
  provisionCashWalletMigrationDestination,
  recordCashWalletMigrationBalance,
  sendCashWalletMigrationBalanceMovePayment,
  sendCashWalletMigrationFeeReimbursementPayment,
  skipCashWalletMigrationFeeReimbursement,
  startCashWalletMigration,
  verifyCashWalletMigrationBalanceMove,
  verifyCashWalletMigrationLegacyZero,
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

const expiredCutoverPaymentRequest =
  "lnbc1p4pcau7pp5gaweqhcssvpgcnmqemwhr2vy024yyc9a9lggu2mq9dmxfla939nsdyqvdshx6pdwaskcmr9wskkxat5damx2u36d4skuatpdsknxdfn8geryvesv5cnwepdxuerswfdxsmnxd3dvgenvc3dv9nr2enzxsek2etpxvcr5cnpd3skucm994kk7an9cqzzsxqzpusp5dxuvs8zkzt0tdjkz5ezuea6j49p7yhu43kurz8wcf2xryryp0anq9qxpqysgqnypt73d64vpk74kgdk26s0r7c3yufn2yxpyae3h6zagved5dy2hjek3hxsa3nxqqe5pppqygcrxt6t99tgqc66zet4m99yldkq6muysqvvdhu9" as EncodedPaymentRequest

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

  it("provisions the destination wallet before reading balances", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => migration("provisioned")),
    }
    const provisioningService = {
      ensureDestinationWallet: jest.fn(async () => true as const),
    }

    const result = await provisionCashWalletMigrationDestination({
      migration: migration("started"),
      provisioningService,
      migrationsRepo,
    })

    expect(result).toMatchObject({ status: "provisioned" })
    expect(provisioningService.ensureDestinationWallet).toHaveBeenCalledWith({
      accountId: "account-id",
      destinationUsdtWalletId: "usdt-wallet-id",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "started",
      to: "provisioned",
      cutoverVersion: 7,
      runId: "run-7",
    })
  })

  it("returns destination wallet provisioning failures without advancing", async () => {
    const error = new CouldNotUpdateError("destination wallet missing")
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const provisioningService = {
      ensureDestinationWallet: jest.fn(async () => error),
    }

    const result = await provisionCashWalletMigrationDestination({
      migration: migration("started"),
      provisioningService,
      migrationsRepo,
    })

    expect(result).toBe(error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("records source balance and destination amount before creating invoices", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("balance_read"),
        sourceBalanceUsdCents: "1234",
        destinationAmountUsdtMicros: "12340000",
        destinationStartingBalanceUsdtMicros: "5000000",
      })),
    }

    const result = await recordCashWalletMigrationBalance({
      migration: migration("provisioned"),
      migrationsRepo,
      sourceBalanceUsdCents: "1234",
      destinationStartingBalanceUsdtMicros: "5000000",
    })

    expect(result).toMatchObject({
      status: "balance_read",
      sourceBalanceUsdCents: "1234",
      destinationAmountUsdtMicros: "12340000",
      destinationStartingBalanceUsdtMicros: "5000000",
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
        destinationStartingBalanceUsdtMicros: "5000000",
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
      destinationStartingBalanceUsdtMicros: "0",
    })

    expect(result).toBeInstanceOf(Error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("creates a no-amount balance move invoice on the destination wallet", async () => {
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
      createNoAmountInvoice: jest.fn(async () => invoice),
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
    expect(invoiceService.createNoAmountInvoice).toHaveBeenCalledWith({
      recipientWalletId: "usdt-wallet-id",
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
      createNoAmountInvoice: jest.fn(),
    }

    const result = await createCashWalletMigrationBalanceMoveInvoice({
      migration: migration("balance_read"),
      invoiceService,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(Error)
    expect(invoiceService.createNoAmountInvoice).not.toHaveBeenCalled()
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("returns balance move invoice creation failures without advancing the checkpoint", async () => {
    const error = new CouldNotUpdateError("invoice creation failed")
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const invoiceService = {
      createNoAmountInvoice: jest.fn(async () => error),
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

  it("sends the balance move payment from the legacy wallet capped to the recorded source balance", async () => {
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
        sourceBalanceUsdCents: "1000",
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
      senderAmountUsdCents: "1000",
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

  it("regenerates an expired balance move invoice before paying it", async () => {
    const refreshedInvoice = {
      paymentRequest: "lnbc1fresh-balance-move" as EncodedPaymentRequest,
      paymentHash: "freshBalanceMoveHash" as PaymentHash,
    } as LnInvoice
    const refreshedMigration = {
      ...migration("invoice_created"),
      balanceMoveInvoicePaymentRequest: refreshedInvoice.paymentRequest,
      balanceMoveInvoicePaymentHash: refreshedInvoice.paymentHash,
      sourceBalanceUsdCents: "1000",
      destinationAmountUsdtMicros: "10000000",
    }
    const migrationsRepo = {
      transitionMigration: jest
        .fn()
        .mockResolvedValueOnce(refreshedMigration)
        .mockResolvedValueOnce({
          ...refreshedMigration,
          status: "balance_move_sending",
          balanceMovePaymentTransactionId: "ibex-tx-id",
        }),
    }
    const invoiceService = {
      createNoAmountInvoice: jest.fn(async () => refreshedInvoice),
    }
    const paymentService = {
      payInvoice: jest.fn(async () => ({
        transactionId: "ibex-tx-id" as IbexTransactionId,
      })),
    }

    const args = {
      migration: {
        ...migration("invoice_created"),
        balanceMoveInvoicePaymentRequest: expiredCutoverPaymentRequest,
        balanceMoveInvoicePaymentHash: "expiredBalanceMoveHash" as PaymentHash,
        sourceBalanceUsdCents: "1000",
        destinationAmountUsdtMicros: "10000000",
      },
      paymentService,
      invoiceService,
      migrationsRepo,
      now: () => new Date("2026-05-31T18:04:00Z"),
    }
    const result = await sendCashWalletMigrationBalanceMovePayment(args)

    expect(result).toMatchObject({
      status: "balance_move_sending",
      balanceMovePaymentTransactionId: "ibex-tx-id",
    })
    expect(invoiceService.createNoAmountInvoice).toHaveBeenCalledWith({
      recipientWalletId: "usdt-wallet-id",
      memo: "cash-wallet-cutover:run-7:migration-id:balance-move",
    })
    expect(paymentService.payInvoice).toHaveBeenCalledWith({
      senderWalletId: "legacy-usd-wallet-id",
      paymentRequest: "lnbc1fresh-balance-move",
      senderAmountUsdCents: "1000",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenNthCalledWith(1, {
      id: "migration-id",
      from: "invoice_created",
      to: "invoice_created",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        balanceMoveInvoicePaymentRequest: "lnbc1fresh-balance-move",
        balanceMoveInvoicePaymentHash: "freshBalanceMoveHash",
      },
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenNthCalledWith(2, {
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

  it("rejects balance move payment sending when the source balance is missing", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const paymentService = {
      payInvoice: jest.fn(),
    }

    const result = await sendCashWalletMigrationBalanceMovePayment({
      migration: {
        ...migration("invoice_created"),
        balanceMoveInvoicePaymentRequest: "lnbc1balance-move",
      },
      paymentService,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(Error)
    expect(paymentService.payInvoice).not.toHaveBeenCalled()
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("marks the balance move payment as sent after a transaction id is recorded", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("balance_move_sent"),
        balanceMovePaymentTransactionId: "ibex-tx-id",
      })),
    }

    const result = await markCashWalletMigrationBalanceMoveSent({
      migration: {
        ...migration("balance_move_sending"),
        balanceMovePaymentTransactionId: "ibex-tx-id",
      },
      migrationsRepo,
    })

    expect(result).toMatchObject({
      status: "balance_move_sent",
      balanceMovePaymentTransactionId: "ibex-tx-id",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "balance_move_sending",
      to: "balance_move_sent",
      cutoverVersion: 7,
      runId: "run-7",
    })
  })

  it("rejects marking the balance move payment as sent before a transaction id exists", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }

    const result = await markCashWalletMigrationBalanceMoveSent({
      migration: migration("balance_move_sending"),
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(Error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("verifies the balance move before fee reimbursement", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => migration("balance_move_verified")),
    }
    const balanceVerifier = {
      verifyBalanceMove: jest.fn(async () => true as const),
    }

    const result = await verifyCashWalletMigrationBalanceMove({
      migration: {
        ...migration("balance_move_sent"),
        balanceMovePaymentTransactionId: "ibex-tx-id",
      },
      balanceVerifier,
      migrationsRepo,
    })

    expect(result).toMatchObject({ status: "balance_move_verified" })
    expect(balanceVerifier.verifyBalanceMove).toHaveBeenCalledWith({
      legacyUsdWalletId: "legacy-usd-wallet-id",
      destinationUsdtWalletId: "usdt-wallet-id",
      sourceBalanceUsdCents: undefined,
      destinationAmountUsdtMicros: undefined,
      transactionId: "ibex-tx-id",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "balance_move_sent",
      to: "balance_move_verified",
      cutoverVersion: 7,
      runId: "run-7",
    })
  })

  it("returns balance move verification failures without advancing the checkpoint", async () => {
    const error = new CouldNotUpdateError("balance move not settled")
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const balanceVerifier = {
      verifyBalanceMove: jest.fn(async () => error),
    }

    const result = await verifyCashWalletMigrationBalanceMove({
      migration: {
        ...migration("balance_move_sent"),
        balanceMovePaymentTransactionId: "ibex-tx-id",
      },
      balanceVerifier,
      migrationsRepo,
    })

    expect(result).toBe(error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("rejects balance move verification before a transaction id exists", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const balanceVerifier = {
      verifyBalanceMove: jest.fn(),
    }

    const result = await verifyCashWalletMigrationBalanceMove({
      migration: migration("balance_move_sent"),
      balanceVerifier,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(Error)
    expect(balanceVerifier.verifyBalanceMove).not.toHaveBeenCalled()
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("creates a fee reimbursement invoice rounded up to USD-cent USDT micros", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("fee_reimbursement_invoice_created"),
        feeAmountUsdCents: "8",
        feeAmountUsdtMicros: "70001",
        feeReimbursementInvoicePaymentRequest: "lnbc1fee-reimbursement",
        feeReimbursementInvoicePaymentHash: "feePaymentHash",
      })),
    }
    const invoice = {
      paymentRequest: "lnbc1fee-reimbursement" as EncodedPaymentRequest,
      paymentHash: "feePaymentHash" as PaymentHash,
    } as LnInvoice
    const invoiceService = {
      createInvoice: jest.fn(async () => invoice),
    }

    const result = await createCashWalletMigrationFeeReimbursementInvoice({
      migration: migration("balance_move_verified"),
      invoiceService,
      migrationsRepo,
      feeAmountUsdtMicros: "70001",
    })

    expect(result).toMatchObject({
      status: "fee_reimbursement_invoice_created",
      feeAmountUsdCents: "8",
      feeAmountUsdtMicros: "70001",
      feeReimbursementInvoicePaymentRequest: "lnbc1fee-reimbursement",
      feeReimbursementInvoicePaymentHash: "feePaymentHash",
    })
    expect(invoiceService.createInvoice).toHaveBeenCalledWith({
      recipientWalletId: "usdt-wallet-id",
      amount: "80000",
      memo: "cash-wallet-cutover:run-7:migration-id:fee-reimbursement",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "balance_move_verified",
      to: "fee_reimbursement_invoice_created",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        feeAmountUsdCents: "8",
        feeAmountUsdtMicros: "70001",
        feeReimbursementInvoicePaymentRequest: "lnbc1fee-reimbursement",
        feeReimbursementInvoicePaymentHash: "feePaymentHash",
      },
    })
  })

  it("rejects invalid fee reimbursement amounts before creating an invoice", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const invoiceService = {
      createInvoice: jest.fn(),
    }

    const result = await createCashWalletMigrationFeeReimbursementInvoice({
      migration: migration("balance_move_verified"),
      invoiceService,
      migrationsRepo,
      feeAmountUsdtMicros: "0.07",
    })

    expect(result).toBeInstanceOf(Error)
    expect(invoiceService.createInvoice).not.toHaveBeenCalled()
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("returns fee reimbursement invoice creation failures without advancing", async () => {
    const error = new CouldNotUpdateError("fee invoice failed")
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const invoiceService = {
      createInvoice: jest.fn(async () => error),
    }

    const result = await createCashWalletMigrationFeeReimbursementInvoice({
      migration: migration("balance_move_verified"),
      invoiceService,
      migrationsRepo,
      feeAmountUsdtMicros: "70000",
    })

    expect(result).toBe(error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("skips fee reimbursement when there is no destination shortfall", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("fee_reimbursed"),
        feeAmountUsdCents: "0",
        feeAmountUsdtMicros: "0",
      })),
    }

    const result = await skipCashWalletMigrationFeeReimbursement({
      migration: migration("balance_move_verified"),
      migrationsRepo,
    })

    expect(result).toMatchObject({
      status: "fee_reimbursed",
      feeAmountUsdCents: "0",
      feeAmountUsdtMicros: "0",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "balance_move_verified",
      to: "fee_reimbursed",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        feeAmountUsdCents: "0",
        feeAmountUsdtMicros: "0",
      },
    })
  })

  it("sends the fee reimbursement payment from the treasury wallet", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("fee_reimbursement_sending"),
        feeReimbursementPaymentTransactionId: "fee-ibex-tx-id",
      })),
    }
    const paymentService = {
      payInvoice: jest.fn(async () => ({
        transactionId: "fee-ibex-tx-id" as IbexTransactionId,
      })),
    }

    const result = await sendCashWalletMigrationFeeReimbursementPayment({
      migration: {
        ...migration("fee_reimbursement_invoice_created"),
        feeReimbursementInvoicePaymentRequest: "lnbc1fee-reimbursement",
      },
      treasuryWalletId: "treasury-wallet-id" as WalletId,
      paymentService,
      migrationsRepo,
    })

    expect(result).toMatchObject({
      status: "fee_reimbursement_sending",
      feeReimbursementPaymentTransactionId: "fee-ibex-tx-id",
    })
    expect(paymentService.payInvoice).toHaveBeenCalledWith({
      senderWalletId: "treasury-wallet-id",
      paymentRequest: "lnbc1fee-reimbursement",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "fee_reimbursement_invoice_created",
      to: "fee_reimbursement_sending",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        feeReimbursementPaymentTransactionId: "fee-ibex-tx-id",
      },
    })
  })

  it("regenerates an expired fee reimbursement invoice before paying it", async () => {
    const refreshedInvoice = {
      paymentRequest: "lnbc1fresh-fee-reimbursement" as EncodedPaymentRequest,
      paymentHash: "freshFeeReimbursementHash" as PaymentHash,
    } as LnInvoice
    const refreshedMigration = {
      ...migration("fee_reimbursement_invoice_created"),
      feeAmountUsdCents: "8",
      feeAmountUsdtMicros: "70001",
      feeReimbursementInvoicePaymentRequest: refreshedInvoice.paymentRequest,
      feeReimbursementInvoicePaymentHash: refreshedInvoice.paymentHash,
    }
    const migrationsRepo = {
      transitionMigration: jest
        .fn()
        .mockResolvedValueOnce(refreshedMigration)
        .mockResolvedValueOnce({
          ...refreshedMigration,
          status: "fee_reimbursement_sending",
          feeReimbursementPaymentTransactionId: "fee-ibex-tx-id",
        }),
    }
    const invoiceService = {
      createInvoice: jest.fn(async () => refreshedInvoice),
    }
    const paymentService = {
      payInvoice: jest.fn(async () => ({
        transactionId: "fee-ibex-tx-id" as IbexTransactionId,
      })),
    }

    const args = {
      migration: {
        ...migration("fee_reimbursement_invoice_created"),
        feeAmountUsdCents: "8",
        feeAmountUsdtMicros: "70001",
        feeReimbursementInvoicePaymentRequest: expiredCutoverPaymentRequest,
        feeReimbursementInvoicePaymentHash: "expiredFeeReimbursementHash" as PaymentHash,
      },
      treasuryWalletId: "treasury-wallet-id" as WalletId,
      paymentService,
      invoiceService,
      migrationsRepo,
      now: () => new Date("2026-05-31T18:04:00Z"),
    }
    const result = await sendCashWalletMigrationFeeReimbursementPayment(args)

    expect(result).toMatchObject({
      status: "fee_reimbursement_sending",
      feeReimbursementPaymentTransactionId: "fee-ibex-tx-id",
    })
    expect(invoiceService.createInvoice).toHaveBeenCalledWith({
      recipientWalletId: "usdt-wallet-id",
      amount: "80000",
      memo: "cash-wallet-cutover:run-7:migration-id:fee-reimbursement",
    })
    expect(paymentService.payInvoice).toHaveBeenCalledWith({
      senderWalletId: "treasury-wallet-id",
      paymentRequest: "lnbc1fresh-fee-reimbursement",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenNthCalledWith(1, {
      id: "migration-id",
      from: "fee_reimbursement_invoice_created",
      to: "fee_reimbursement_invoice_created",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        feeAmountUsdCents: "8",
        feeAmountUsdtMicros: "70001",
        feeReimbursementInvoicePaymentRequest: "lnbc1fresh-fee-reimbursement",
        feeReimbursementInvoicePaymentHash: "freshFeeReimbursementHash",
      },
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenNthCalledWith(2, {
      id: "migration-id",
      from: "fee_reimbursement_invoice_created",
      to: "fee_reimbursement_sending",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        feeReimbursementPaymentTransactionId: "fee-ibex-tx-id",
      },
    })
  })

  it("rejects fee reimbursement sending when the invoice payment request is missing", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const paymentService = {
      payInvoice: jest.fn(),
    }

    const result = await sendCashWalletMigrationFeeReimbursementPayment({
      migration: migration("fee_reimbursement_invoice_created"),
      treasuryWalletId: "treasury-wallet-id" as WalletId,
      paymentService,
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(Error)
    expect(paymentService.payInvoice).not.toHaveBeenCalled()
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("returns fee reimbursement payment failures without advancing", async () => {
    const error = new CouldNotUpdateError("fee payment failed")
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const paymentService = {
      payInvoice: jest.fn(async () => error),
    }

    const result = await sendCashWalletMigrationFeeReimbursementPayment({
      migration: {
        ...migration("fee_reimbursement_invoice_created"),
        feeReimbursementInvoicePaymentRequest: "lnbc1fee-reimbursement",
      },
      treasuryWalletId: "treasury-wallet-id" as WalletId,
      paymentService,
      migrationsRepo,
    })

    expect(result).toBe(error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("marks the fee reimbursement as complete after a transaction id is recorded", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("fee_reimbursed"),
        feeReimbursementPaymentTransactionId: "fee-ibex-tx-id",
      })),
    }

    const result = await markCashWalletMigrationFeeReimbursed({
      migration: {
        ...migration("fee_reimbursement_sending"),
        feeReimbursementPaymentTransactionId: "fee-ibex-tx-id",
      },
      migrationsRepo,
    })

    expect(result).toMatchObject({
      status: "fee_reimbursed",
      feeReimbursementPaymentTransactionId: "fee-ibex-tx-id",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "fee_reimbursement_sending",
      to: "fee_reimbursed",
      cutoverVersion: 7,
      runId: "run-7",
    })
  })

  it("rejects marking fee reimbursement complete before a transaction id exists", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }

    const result = await markCashWalletMigrationFeeReimbursed({
      migration: migration("fee_reimbursement_sending"),
      migrationsRepo,
    })

    expect(result).toBeInstanceOf(Error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("flips the account default pointer to the destination USDT wallet", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("pointer_flipped"),
        previousDefaultWalletId: "legacy-usd-wallet-id" as WalletId,
      })),
    }
    const pointerService = {
      flipDefaultWallet: jest.fn(async () => ({
        previousDefaultWalletId: "legacy-usd-wallet-id" as WalletId,
      })),
    }

    const result = await flipCashWalletMigrationDefaultPointer({
      migration: migration("fee_reimbursed"),
      pointerService,
      migrationsRepo,
    })

    expect(result).toMatchObject({
      status: "pointer_flipped",
      previousDefaultWalletId: "legacy-usd-wallet-id",
    })
    expect(pointerService.flipDefaultWallet).toHaveBeenCalledWith({
      accountId: "account-id",
      destinationWalletId: "usdt-wallet-id",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "fee_reimbursed",
      to: "pointer_flipped",
      cutoverVersion: 7,
      runId: "run-7",
      patch: {
        previousDefaultWalletId: "legacy-usd-wallet-id",
      },
    })
  })

  it("returns pointer flip failures without advancing", async () => {
    const error = new CouldNotUpdateError("default wallet update failed")
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const pointerService = {
      flipDefaultWallet: jest.fn(async () => error),
    }

    const result = await flipCashWalletMigrationDefaultPointer({
      migration: migration("fee_reimbursed"),
      pointerService,
      migrationsRepo,
    })

    expect(result).toBe(error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("verifies the legacy USD wallet is zero after the pointer flip", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => migration("legacy_zero_verified")),
    }
    const legacyWalletVerifier = {
      verifyLegacyWalletZero: jest.fn(async () => true as const),
    }

    const result = await verifyCashWalletMigrationLegacyZero({
      migration: migration("pointer_flipped"),
      legacyWalletVerifier,
      migrationsRepo,
    })

    expect(result).toMatchObject({ status: "legacy_zero_verified" })
    expect(legacyWalletVerifier.verifyLegacyWalletZero).toHaveBeenCalledWith({
      legacyUsdWalletId: "legacy-usd-wallet-id",
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "pointer_flipped",
      to: "legacy_zero_verified",
      cutoverVersion: 7,
      runId: "run-7",
    })
  })

  it("returns legacy zero verification failures without advancing", async () => {
    const error = new CouldNotUpdateError("legacy wallet still has a balance")
    const migrationsRepo = {
      transitionMigration: jest.fn(),
    }
    const legacyWalletVerifier = {
      verifyLegacyWalletZero: jest.fn(async () => error),
    }

    const result = await verifyCashWalletMigrationLegacyZero({
      migration: migration("pointer_flipped"),
      legacyWalletVerifier,
      migrationsRepo,
    })

    expect(result).toBe(error)
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("completes the migration after legacy zero verification", async () => {
    const completedAt = new Date("2026-05-20T15:30:00Z")
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => ({
        ...migration("complete"),
        completedAt,
      })),
    }

    const result = await completeCashWalletMigration({
      migration: migration("legacy_zero_verified"),
      migrationsRepo,
      completedAt,
    })

    expect(result).toMatchObject({
      status: "complete",
      completedAt,
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "legacy_zero_verified",
      to: "complete",
      cutoverVersion: 7,
      runId: "run-7",
      patch: { completedAt },
    })
  })
})
