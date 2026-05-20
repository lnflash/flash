import { CouldNotUpdateError } from "@domain/errors"
import { USDAmount, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

jest.mock("@app/accounts", () => ({
  addWalletIfNonexistent: jest.fn(),
  updateDefaultWalletId: jest.fn(),
}))
jest.mock("@app/wallets", () => ({
  addInvoiceForRecipientForUsdWallet: jest.fn(),
  getBalanceForWallet: jest.fn(),
}))
jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({ findById: jest.fn() })),
}))
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    payInvoice: jest.fn(),
    getTransactionDetails: jest.fn(),
  },
}))

import { createCashWalletMigrationRuntimeServices } from "@app/cash-wallet-cutover/runtime-services"

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

  it("extracts the IBEX transaction id after paying an invoice", async () => {
    const deps = {
      payInvoice: jest.fn(async () => ({
        transaction: { id: "ibex-tx-id" },
      })),
    }

    const services = createCashWalletMigrationRuntimeServices(deps)

    const result = await services.paymentService.payInvoice({
      senderWalletId: "legacy-usd-wallet-id" as WalletId,
      paymentRequest: "lnbc1payment",
    })

    expect(result).toEqual({ transactionId: "ibex-tx-id" })
    expect(deps.payInvoice).toHaveBeenCalledWith({
      accountId: "legacy-usd-wallet-id",
      invoice: "lnbc1payment",
    })
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

  it("reads the balance move fee as rounded-up USD cents", async () => {
    const deps = {
      getTransactionDetails: jest.fn(async () => ({
        networkFee: 0.077,
      })),
    }

    const services = createCashWalletMigrationRuntimeServices(deps)

    const result = await services.feeService.readFeeAmountUsdCents(
      migration({ balanceMovePaymentTransactionId: "ibex-tx-id" }),
    )

    expect(result).toBe("8")
    expect(deps.getTransactionDetails).toHaveBeenCalledWith("ibex-tx-id")
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
