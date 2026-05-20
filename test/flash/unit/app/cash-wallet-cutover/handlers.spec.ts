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
      },
      invoiceService: {
        createInvoice: jest.fn(
          async () =>
            ({
              paymentRequest: "lnbc1" as EncodedPaymentRequest,
              paymentHash: "hash" as PaymentHash,
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
        readFeeAmountUsdCents: jest.fn(async () => "7"),
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
    expect(services.feeService.readFeeAmountUsdCents).toHaveBeenCalledWith(
      migration("balance_move_verified"),
    )
  })
})
