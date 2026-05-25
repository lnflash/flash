import { createCashWalletMigrationStepHandlers } from "@app/cash-wallet-cutover/handlers"

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

describe("cash wallet migration step handlers", () => {
  it("builds handlers for every runnable status", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async ({ to }) => migration(to)),
    }
    const services = {
      now: jest.fn(() => new Date("2026-05-20T16:00:00Z")),
      provisioningService: {
        ensureDestinationWallet: jest.fn(async () => true),
      },
      balanceReader: {
        readSourceBalanceUsdCents: jest.fn(async () => "1234"),
        readDestinationBalanceUsdtMicros: jest.fn(async () => "5000000"),
      },
      invoiceService: {
        createInvoice: jest.fn(
          async () =>
            ({
              paymentRequest: "lnbc1" as EncodedPaymentRequest,
              paymentHash: "hash" as PaymentHash,
            }) as LnInvoice,
        ),
        createNoAmountInvoice: jest.fn(
          async () =>
            ({
              paymentRequest: "lnbc1-no-amount" as EncodedPaymentRequest,
              paymentHash: "noAmountHash" as PaymentHash,
            }) as LnInvoice,
        ),
      },
      paymentService: {
        payInvoice: jest.fn(async () => ({
          transactionId: "ibex-tx-id" as IbexTransactionId,
        })),
      },
      balanceVerifier: {
        verifyBalanceMove: jest.fn(async () => true),
      },
      feeService: {
        readFeeAmountUsdtMicros: jest.fn(async () => "70000"),
      },
      treasuryService: {
        getTreasuryWalletId: jest.fn(async () => "treasury-wallet-id" as WalletId),
      },
      pointerService: {
        flipDefaultWallet: jest.fn(async () => ({
          previousDefaultWalletId: "legacy-usd-wallet-id" as WalletId,
        })),
      },
      legacyWalletVerifier: {
        verifyLegacyWalletZero: jest.fn(async () => true),
      },
    }

    const handlers = createCashWalletMigrationStepHandlers({
      migrationsRepo,
      services,
    })

    expect(Object.keys(handlers).sort()).toEqual([
      "balance_move_sending",
      "balance_move_sent",
      "balance_move_verified",
      "balance_read",
      "fee_reimbursed",
      "fee_reimbursement_invoice_created",
      "fee_reimbursement_sending",
      "invoice_created",
      "legacy_zero_verified",
      "not_started",
      "pointer_flipped",
      "provisioned",
      "started",
    ])

    await handlers.not_started(migration("not_started"))
    await handlers.started(migration("started"))
    await handlers.provisioned(migration("provisioned"))
    await handlers.balance_move_verified(migration("balance_move_verified"))

    expect(services.now).toHaveBeenCalled()
    expect(services.provisioningService.ensureDestinationWallet).toHaveBeenCalled()
    expect(services.balanceReader.readSourceBalanceUsdCents).toHaveBeenCalledWith(
      migration("provisioned"),
    )
    expect(services.balanceReader.readDestinationBalanceUsdtMicros).toHaveBeenCalledWith(
      migration("provisioned"),
    )
    expect(services.feeService.readFeeAmountUsdtMicros).toHaveBeenCalledWith(
      migration("balance_move_verified"),
    )
  })

  it("skips balance move and fee reimbursement for zero-balance migrations", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async ({ to }) => migration(to)),
    }
    const services = {
      now: jest.fn(() => new Date("2026-05-20T16:00:00Z")),
      provisioningService: {
        ensureDestinationWallet: jest.fn(async () => true),
      },
      balanceReader: {
        readSourceBalanceUsdCents: jest.fn(async () => "0"),
        readDestinationBalanceUsdtMicros: jest.fn(async () => "0"),
      },
      invoiceService: {
        createInvoice: jest.fn(),
        createNoAmountInvoice: jest.fn(),
      },
      paymentService: {
        payInvoice: jest.fn(),
      },
      balanceVerifier: {
        verifyBalanceMove: jest.fn(),
      },
      feeService: {
        readFeeAmountUsdtMicros: jest.fn(),
      },
      treasuryService: {
        getTreasuryWalletId: jest.fn(),
      },
      pointerService: {
        flipDefaultWallet: jest.fn(async () => ({
          previousDefaultWalletId: "legacy-usd-wallet-id" as WalletId,
        })),
      },
      legacyWalletVerifier: {
        verifyLegacyWalletZero: jest.fn(async () => true),
      },
    }

    const handlers = createCashWalletMigrationStepHandlers({
      migrationsRepo,
      services,
    })

    const result = await handlers.balance_read({
      ...migration("balance_read"),
      sourceBalanceUsdCents: "0",
      destinationAmountUsdtMicros: "0",
    })

    expect(result).toMatchObject({ status: "pointer_flipped" })
    expect(services.pointerService.flipDefaultWallet).toHaveBeenCalledWith({
      accountId: "account-id",
      destinationWalletId: "usdt-wallet-id",
    })
    expect(services.invoiceService.createInvoice).not.toHaveBeenCalled()
    expect(services.invoiceService.createNoAmountInvoice).not.toHaveBeenCalled()
    expect(services.paymentService.payInvoice).not.toHaveBeenCalled()
    expect(services.balanceVerifier.verifyBalanceMove).not.toHaveBeenCalled()
    expect(services.feeService.readFeeAmountUsdtMicros).not.toHaveBeenCalled()
    expect(services.treasuryService.getTreasuryWalletId).not.toHaveBeenCalled()
  })

  it("skips fee reimbursement invoice creation when the destination shortfall is zero", async () => {
    const migrationsRepo = {
      transitionMigration: jest.fn(async ({ to, patch }) => ({
        ...migration(to),
        ...patch,
      })),
    }
    const services = {
      now: jest.fn(() => new Date("2026-05-20T16:00:00Z")),
      provisioningService: {
        ensureDestinationWallet: jest.fn(async () => true),
      },
      balanceReader: {
        readSourceBalanceUsdCents: jest.fn(async () => "1000"),
        readDestinationBalanceUsdtMicros: jest.fn(async () => "0"),
      },
      invoiceService: {
        createInvoice: jest.fn(),
        createNoAmountInvoice: jest.fn(),
      },
      paymentService: {
        payInvoice: jest.fn(),
      },
      balanceVerifier: {
        verifyBalanceMove: jest.fn(async () => true),
      },
      feeService: {
        readFeeAmountUsdtMicros: jest.fn(async () => "0"),
      },
      treasuryService: {
        getTreasuryWalletId: jest.fn(),
      },
      pointerService: {
        flipDefaultWallet: jest.fn(async () => ({
          previousDefaultWalletId: "legacy-usd-wallet-id" as WalletId,
        })),
      },
      legacyWalletVerifier: {
        verifyLegacyWalletZero: jest.fn(async () => true),
      },
    }

    const handlers = createCashWalletMigrationStepHandlers({
      migrationsRepo,
      services,
    })

    const result = await handlers.balance_move_verified(
      migration("balance_move_verified"),
    )

    expect(result).toMatchObject({
      status: "fee_reimbursed",
      feeAmountUsdCents: "0",
      feeAmountUsdtMicros: "0",
    })
    expect(services.invoiceService.createInvoice).not.toHaveBeenCalled()
    expect(services.treasuryService.getTreasuryWalletId).not.toHaveBeenCalled()
  })
})
