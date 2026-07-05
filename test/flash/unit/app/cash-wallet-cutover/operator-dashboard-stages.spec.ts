import {
  deriveCashWalletCutoverMilestones,
  summarizeCashWalletCutoverStages,
} from "@app/cash-wallet-cutover/operator-dashboard"

const AT = "2026-07-05T12:00:00.000Z"

const summary = (
  statuses: (CashWalletMigrationStatus | "none")[],
  {
    state = "in_progress" as CashWalletCutoverState,
    missingUsdt = 0,
    runId = "run-1",
  } = {},
) =>
  summarizeCashWalletCutoverStages({
    migrationStatuses: statuses,
    cutoverState: state,
    runId,
    missingUsdtWallets: missingUsdt,
  })

describe("summarizeCashWalletCutoverStages", () => {
  it("groups every migration status into a stage", () => {
    const s = summary([
      "none",
      "not_started",
      "started",
      "balance_move_sending",
      "fee_reimbursed",
      "pointer_flipped",
      "complete",
      "skipped_already_migrated",
      "failed",
      "requires_operator_review",
      "rollback_started",
      "rolled_back",
    ])

    expect(s.counts).toMatchObject({
      pending: 2,
      provisioning: 1,
      moving: 1,
      fees: 1,
      finalizing: 1,
      complete: 1,
      skipped: 1,
      attention: 2,
      rollingBack: 1,
      rolledBack: 1,
    })
    expect(s.inFlight).toBe(4)
    expect(s.done).toBe(2)
    expect(s.total).toBe(12)
  })

  it("excludes permanently-none accounts from the denominator once the run started", () => {
    // "none" accounts (already_usdt / residual / missing_*) never get
    // migration records — counting them caps percentComplete below 100
    // forever (TEST: 315 manifest vs 297 migrations ⇒ 94% ceiling).
    const s = summary(["complete", "skipped_already_migrated", "none", "none"])
    expect(s.total).toBe(4)
    expect(s.eligibleTotal).toBe(2)
    expect(s.percentComplete).toBe(100)
  })

  it("keeps none accounts in the denominator before the run starts", () => {
    const s = summary(["complete", "skipped_already_migrated", "none", "none"], {
      state: "pre" as CashWalletCutoverState,
    })
    expect(s.eligibleTotal).toBe(4)
    expect(s.percentComplete).toBe(50)
  })
})

describe("deriveCashWalletCutoverMilestones", () => {
  it("emits nothing on the first observation", () => {
    expect(
      deriveCashWalletCutoverMilestones({ current: summary(["none"]), at: AT }),
    ).toEqual([])
  })

  it("announces run start, completion, and rollback state changes", () => {
    const pre = summary(["none"], { state: "pre" })
    const started = deriveCashWalletCutoverMilestones({
      previous: pre,
      current: summary(["none"]),
      at: AT,
    })
    expect(started).toEqual([
      { at: AT, kind: "info", text: "Cutover run started (run-1)" },
    ])

    const done = deriveCashWalletCutoverMilestones({
      previous: summary(["complete"]),
      current: summary(["complete"], { state: "complete" }),
      at: AT,
    })
    expect(done.some((m) => m.kind === "ok" && /COMPLETE/.test(m.text))).toBe(true)

    const rolled = deriveCashWalletCutoverMilestones({
      previous: summary(["rolled_back"]),
      current: summary(["rolled_back"], { state: "rolled_back" }),
      at: AT,
    })
    expect(rolled.some((m) => m.kind === "warn" && /ROLLED BACK/.test(m.text))).toBe(true)
  })

  it("announces provisioning completion when missing USDT wallets reach zero", () => {
    const out = deriveCashWalletCutoverMilestones({
      previous: summary(["none"], { missingUsdt: 5 }),
      current: summary(["none"], { missingUsdt: 0 }),
      at: AT,
    })
    expect(out.some((m) => /Provisioning complete/.test(m.text))).toBe(true)
  })

  it("announces first in-flight, first complete, and percent thresholds", () => {
    const quiet = summary(["none", "none", "none", "none"])
    const moving = deriveCashWalletCutoverMilestones({
      previous: quiet,
      current: summary(["balance_move_sending", "none", "none", "none"]),
      at: AT,
    })
    expect(moving.some((m) => /Migration batch running/.test(m.text))).toBe(true)

    const firstDone = deriveCashWalletCutoverMilestones({
      previous: summary(["balance_move_sending", "none", "none", "none"]),
      current: summary(["complete", "none", "none", "none"]),
      at: AT,
    })
    expect(firstDone.some((m) => /First account fully migrated/.test(m.text))).toBe(true)
    expect(firstDone.some((m) => /25% migrated/.test(m.text))).toBe(true)

    const allDone = deriveCashWalletCutoverMilestones({
      previous: summary(["complete", "complete", "complete", "pointer_flipped"]),
      current: summary(["complete", "complete", "complete", "complete"]),
      at: AT,
    })
    expect(allDone.some((m) => /100% migrated/.test(m.text))).toBe(true)
  })

  it("fires the 100% milestone even when permanently-none accounts exist", () => {
    // The reconciliation cue must fire on real data, where the manifest
    // always contains accounts that never get migration records.
    const out = deriveCashWalletCutoverMilestones({
      previous: summary(["complete", "pointer_flipped", "none", "none"]),
      current: summary(["complete", "complete", "none", "none"]),
      at: AT,
    })
    expect(out.some((m) => /100% migrated \(2\/2\)/.test(m.text))).toBe(true)
  })

  it("announces attention spikes and the queue clearing", () => {
    const spike = deriveCashWalletCutoverMilestones({
      previous: summary(["none", "none"]),
      current: summary(["failed", "requires_operator_review"]),
      at: AT,
    })
    expect(
      spike.some(
        (m) => m.kind === "bad" && /\+2 account\(s\) need attention/.test(m.text),
      ),
    ).toBe(true)

    const cleared = deriveCashWalletCutoverMilestones({
      previous: summary(["failed", "none"]),
      current: summary(["complete", "none"]),
      at: AT,
    })
    expect(cleared.some((m) => /Attention queue cleared/.test(m.text))).toBe(true)
  })

  it("announces rollback start and drain", () => {
    const started = deriveCashWalletCutoverMilestones({
      previous: summary(["complete"]),
      current: summary(["rollback_started"]),
      at: AT,
    })
    expect(started.some((m) => /Rollback in progress/.test(m.text))).toBe(true)

    const drained = deriveCashWalletCutoverMilestones({
      previous: summary(["rollback_started", "rolled_back"]),
      current: summary(["rolled_back", "rolled_back"]),
      at: AT,
    })
    expect(drained.some((m) => /Rollback drained — 2/.test(m.text))).toBe(true)
  })

  it("does not repeat milestones when nothing changes", () => {
    const same = summary(["complete", "none"])
    expect(
      deriveCashWalletCutoverMilestones({ previous: same, current: same, at: AT }),
    ).toEqual([])
  })
})
