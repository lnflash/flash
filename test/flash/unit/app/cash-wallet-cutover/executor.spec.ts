import { CouldNotUpdateError } from "@domain/errors"

import { executeCashWalletMigrationStep } from "@app/cash-wallet-cutover/executor"

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

const handlers = () => ({
  not_started: jest.fn(async () => migration("started")),
  started: jest.fn(async () => migration("provisioned")),
  provisioned: jest.fn(async () => migration("balance_read")),
  balance_read: jest.fn(async () => migration("invoice_created")),
  invoice_created: jest.fn(async () => migration("balance_move_sending")),
  balance_move_sending: jest.fn(async () => migration("balance_move_sent")),
  balance_move_sent: jest.fn(async () => migration("balance_move_verified")),
  balance_move_verified: jest.fn(async () =>
    migration("fee_reimbursement_invoice_created"),
  ),
  fee_reimbursement_invoice_created: jest.fn(async () =>
    migration("fee_reimbursement_sending"),
  ),
  fee_reimbursement_sending: jest.fn(async () => migration("fee_reimbursed")),
  fee_reimbursed: jest.fn(async () => migration("pointer_flipped")),
  pointer_flipped: jest.fn(async () => migration("legacy_zero_verified")),
  legacy_zero_verified: jest.fn(async () => migration("complete")),
})

describe("cash wallet migration executor", () => {
  it("dispatches a runnable migration to the handler for its current status", async () => {
    const stepHandlers = handlers()

    const result = await executeCashWalletMigrationStep({
      migration: migration("invoice_created"),
      handlers: stepHandlers,
    })

    expect(result).toMatchObject({ status: "balance_move_sending" })
    expect(stepHandlers.invoice_created).toHaveBeenCalledWith(
      migration("invoice_created"),
    )
  })

  it("returns terminal migrations without invoking handlers", async () => {
    const stepHandlers = handlers()

    const result = await executeCashWalletMigrationStep({
      migration: migration("requires_operator_review"),
      handlers: stepHandlers,
    })

    expect(result).toMatchObject({ status: "requires_operator_review" })
    expect(Object.values(stepHandlers).some((handler) => handler.mock.calls.length)).toBe(
      false,
    )
  })

  it("returns handler failures without trying a second checkpoint", async () => {
    const error = new CouldNotUpdateError("checkpoint failed")
    const stepHandlers = {
      ...handlers(),
      balance_move_sent: jest.fn(async () => error),
    }

    const result = await executeCashWalletMigrationStep({
      migration: migration("balance_move_sent"),
      handlers: stepHandlers,
    })

    expect(result).toBe(error)
    expect(stepHandlers.balance_move_verified).not.toHaveBeenCalled()
  })
})
