import { computeCutoverBalanceAudit } from "@app/cash-wallet-cutover/operator-dashboard"

const migration = ({
  feePaid,
  feeAmountUsdtMicros = "515",
}: {
  feePaid: boolean
  feeAmountUsdtMicros?: string
}) =>
  ({
    id: "migration-id",
    status: "complete",
    sourceBalanceUsdCents: "100",
    destinationAmountUsdtMicros: "10000",
    destinationStartingBalanceUsdtMicros: "0",
    destinationUsdtWalletId: "dest-wallet" as WalletId,
    feeAmountUsdtMicros,
    ...(feePaid ? { feeReimbursementPaymentTransactionId: "fee-txn" } : {}),
  }) as CashWalletMigration

const wallet = (minorUnitsNumber: number) =>
  ({
    id: "dest-wallet",
    balance: { status: "fresh", minorUnitsNumber },
  }) as never

describe("computeCutoverBalanceAudit — absorbed-fee allowance (ENG-484)", () => {
  it("does not flag an absorbed fee as a shortfall", () => {
    // Fee recorded but never reimbursed: destination legitimately holds
    // target − fee. Must render verified, not a red shortfall row.
    const audit = computeCutoverBalanceAudit({
      migration: migration({ feePaid: false }),
      usdtWallets: [wallet(9485)], // 10000 − 515 absorbed
    })

    expect(audit?.status).toBe("verified")
    expect(audit?.shortfallUsdtMicros).toBe(0)
  })

  it("still flags a real shortfall beyond the absorbed fee", () => {
    const audit = computeCutoverBalanceAudit({
      migration: migration({ feePaid: false }),
      usdtWallets: [wallet(8000)], // short 1485 beyond the absorbed 515
    })

    expect(audit?.status).toBe("shortfall")
    expect(audit?.shortfallUsdtMicros).toBe(1485)
  })

  it("grants no allowance when the fee was actually reimbursed", () => {
    const audit = computeCutoverBalanceAudit({
      migration: migration({ feePaid: true, feeAmountUsdtMicros: "5000" }),
      usdtWallets: [wallet(9000)],
    })

    expect(audit?.status).toBe("shortfall")
    expect(audit?.shortfallUsdtMicros).toBe(1000)
  })
})
