import { CouldNotUpdateError } from "@domain/errors"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

jest.mock("@app/accounts", () => ({
  addWalletIfNonexistent: jest.fn(),
  updateDefaultWalletId: jest.fn(),
}))
jest.mock("@app/wallets", () => ({
  addInvoiceForRecipientForUsdWallet: jest.fn(),
  addInvoiceNoAmountForRecipient: jest.fn(),
  getBalanceForWallet: jest.fn(),
}))
jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({ findById: jest.fn() })),
}))
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    addInvoice: jest.fn(),
    payInvoice: jest.fn(),
    getTransactionDetails: jest.fn(),
  },
}))

import { createCashWalletMigrationRuntimeServices } from "@app/cash-wallet-cutover/runtime-services"
import Ibex from "@services/ibex/client"

const ibexAddInvoiceResponse = {
  invoice: {
    bolt11:
      "lnbc140n1p3k6yzupp53p305l6de6s9xw2j0qaa59pl7lahys4f2uavwncll9z2vq0syvvsdqqcqzpgxqzuysp5mdgsaa734eg7srwx92rsn3hyc4xzt5tphfpadl5c6fanhppwaz4s9qyyssqm6yhnnhl8jltwjtclzk4g7nxr99ycsp4sqd6vksevqh06h8l3gm5fdhtl59t6g3fsalv26sj5zvwhxwlghc9wcfgkrjrtuh4873ejnspc5xksy",
  },
}

const migration = (patch: Partial<CashWalletMigration> = {}): CashWalletMigration => ({
  id: "migration-id",
  accountId: "account-id" as AccountId,
  legacyUsdWalletId: "legacy-usd-wallet-id" as WalletId,
  destinationUsdtWalletId: "usdt-wallet-id" as WalletId,
  cutoverVersion: 7,
  runId: "run-7",
  status: "balance_move_verified",
  idempotencyKey: "cash-wallet-cutover:run-7:account-id",
  attempts: 0,
  updatedAt: new Date("2026-05-20T00:00:00Z"),
  ...patch,
})

describe("cash wallet migration runtime services", () => {
  it("reads source USD balances as cents", async () => {
    const deps = {
      getBalanceForWallet: jest.fn(async () => USDAmount.cents("1234")),
    }

    const services = createCashWalletMigrationRuntimeServices(deps)

    const result = await services.balanceReader.readSourceBalanceUsdCents(migration())

    expect(result).toBe("1234")
    expect(deps.getBalanceForWallet).toHaveBeenCalledWith({
      walletId: "legacy-usd-wallet-id",
      currency: WalletCurrency.Usd,
    })
  })

  it("reads destination USDT balances as micros", async () => {
    const deps = {
      getBalanceForWallet: jest.fn(async () => USDTAmount.smallestUnits("5000000")),
    }

    const services = createCashWalletMigrationRuntimeServices(deps)

    const result =
      await services.balanceReader.readDestinationBalanceUsdtMicros(migration())

    expect(result).toBe("5000000")
    expect(deps.getBalanceForWallet).toHaveBeenCalledWith({
      walletId: "usdt-wallet-id",
      currency: WalletCurrency.Usdt,
    })
  })

  it("ensures the expected destination USDT wallet exists", async () => {
    const deps = {
      addWalletIfNonexistent: jest.fn(async () => ({
        id: "usdt-wallet-id" as WalletId,
      })),
    }

    const services = createCashWalletMigrationRuntimeServices(deps)

    const result = await services.provisioningService.ensureDestinationWallet({
      accountId: "account-id" as AccountId,
      destinationUsdtWalletId: "usdt-wallet-id" as WalletId,
    })

    expect(result).toBe(true)
    expect(deps.addWalletIfNonexistent).toHaveBeenCalledWith({
      accountId: "account-id",
      type: WalletType.Checking,
      currency: WalletCurrency.Usdt,
    })
  })

  it("creates no-amount destination invoices through IBEX", async () => {
    jest.mocked(Ibex.addInvoice).mockResolvedValue(ibexAddInvoiceResponse as never)

    const services = createCashWalletMigrationRuntimeServices()

    const result = await services.invoiceService.createNoAmountInvoice({
      recipientWalletId: "usdt-wallet-id" as WalletId,
      memo: "cash-wallet-cutover:run-7:migration-id:balance-move",
    })

    expect(result).toMatchObject({
      paymentRequest: ibexAddInvoiceResponse.invoice.bolt11,
    })
    expect(Ibex.addInvoice).toHaveBeenCalledWith({
      accountId: "usdt-wallet-id",
      memo: "cash-wallet-cutover:run-7:migration-id:balance-move",
      expiration: 900,
    })
  })

  it("extracts the IBEX transaction id after paying an invoice with a sender-side USD cap", async () => {
    const deps = {
      payInvoice: jest.fn(async () => ({
        transaction: { id: "ibex-tx-id" },
      })),
    }

    const services = createCashWalletMigrationRuntimeServices(deps)

    const result = await services.paymentService.payInvoice({
      senderWalletId: "legacy-usd-wallet-id" as WalletId,
      paymentRequest: "lnbc1payment",
      senderAmountUsdCents: "1000",
    })

    expect(result).toEqual({ transactionId: "ibex-tx-id" })
    const paymentArgs = deps.payInvoice.mock.calls[0][0]
    expect(paymentArgs.accountId).toBe("legacy-usd-wallet-id")
    expect(paymentArgs.invoice).toBe("lnbc1payment")
    expect(paymentArgs.send).toBeInstanceOf(USDAmount)
    expect(paymentArgs.send.asCents()).toBe("1000")
  })

  it("returns an error when IBEX payment response has no transaction id", async () => {
    const services = createCashWalletMigrationRuntimeServices({
      payInvoice: jest.fn(async () => ({})),
    })

    const result = await services.paymentService.payInvoice({
      senderWalletId: "legacy-usd-wallet-id" as WalletId,
      paymentRequest: "lnbc1payment",
    })

    expect(result).toBeInstanceOf(Error)
  })

  it("computes the fee reimbursement as the exact destination USDT shortfall", async () => {
    const deps = {
      getBalanceForWallet: jest.fn(async () => USDTAmount.smallestUnits("14930000")),
    }

    const services = createCashWalletMigrationRuntimeServices(deps)

    const result = await services.feeService.readFeeAmountUsdtMicros(
      migration({
        balanceMovePaymentTransactionId: "ibex-tx-id",
        destinationAmountUsdtMicros: "10000000",
        destinationStartingBalanceUsdtMicros: "5000000",
      }),
    )

    expect(result).toBe("70000")
    expect(deps.getBalanceForWallet).toHaveBeenCalledWith({
      walletId: "usdt-wallet-id",
      currency: WalletCurrency.Usdt,
    })
  })

  it("flips the default wallet and returns the previous default wallet id", async () => {
    const deps = {
      accountsRepo: {
        findById: jest.fn(async () => ({
          defaultWalletId: "legacy-usd-wallet-id" as WalletId,
        })),
      },
      updateDefaultWalletId: jest.fn(async () => ({})),
    }

    const services = createCashWalletMigrationRuntimeServices(deps)

    const result = await services.pointerService.flipDefaultWallet({
      accountId: "account-id" as AccountId,
      destinationWalletId: "usdt-wallet-id" as WalletId,
    })

    expect(result).toEqual({
      previousDefaultWalletId: "legacy-usd-wallet-id",
    })
    expect(deps.updateDefaultWalletId).toHaveBeenCalledWith({
      accountId: "account-id",
      walletId: "usdt-wallet-id",
    })
  })

  it("propagates legacy zero verification errors", async () => {
    const error = new CouldNotUpdateError("balance lookup failed")
    const services = createCashWalletMigrationRuntimeServices({
      getBalanceForWallet: jest.fn(async () => error),
    })

    const result = await services.legacyWalletVerifier.verifyLegacyWalletZero({
      legacyUsdWalletId: "legacy-usd-wallet-id" as WalletId,
    })

    expect(result).toBe(error)
  })
})
