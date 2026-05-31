import {
  assertCanTransition,
  nextResumeStatus,
} from "@app/cash-wallet-cutover/state-machine"

describe("cash wallet cutover migration state machine", () => {
  it("allows the happy-path checkpoint order", () => {
    const statuses = [
      "not_started",
      "started",
      "provisioned",
      "balance_read",
      "invoice_created",
      "balance_move_sending",
      "balance_move_sent",
      "balance_move_verified",
      "fee_reimbursement_invoice_created",
      "fee_reimbursement_sending",
      "fee_reimbursed",
      "pointer_flipped",
      "legacy_zero_verified",
      "complete",
    ] as const

    for (let i = 0; i < statuses.length - 1; i++) {
      expect(assertCanTransition(statuses[i], statuses[i + 1])).toBe(true)
    }
  })

  it("rejects pointer flip before fee reimbursement", () => {
    expect(
      assertCanTransition("balance_move_verified", "pointer_flipped"),
    ).toBeInstanceOf(Error)
  })

  it("allows skipping fee reimbursement when there is no shortfall", () => {
    expect(assertCanTransition("balance_move_verified", "fee_reimbursed")).toBe(true)
  })

  it("allows invoice refreshes before paying resumable invoices", () => {
    expect(assertCanTransition("invoice_created", "invoice_created")).toBe(true)
    expect(
      assertCanTransition(
        "fee_reimbursement_invoice_created",
        "fee_reimbursement_invoice_created",
      ),
    ).toBe(true)
  })

  it("resumes from stored checkpoint without repeating completed side effects", () => {
    expect(nextResumeStatus("invoice_created")).toBe("invoice_created")
    expect(nextResumeStatus("balance_move_sent")).toBe("balance_move_sent")
    expect(nextResumeStatus("fee_reimbursement_invoice_created")).toBe(
      "fee_reimbursement_invoice_created",
    )
  })

  it("does not progress terminal/manual-review states without override", () => {
    expect(assertCanTransition("complete", "started")).toBeInstanceOf(Error)
    expect(assertCanTransition("failed", "started")).toBeInstanceOf(Error)
    expect(assertCanTransition("requires_operator_review", "started")).toBeInstanceOf(
      Error,
    )
  })
})
