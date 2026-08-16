import {
  computeFygaroFees,
  evaluateCreditGate,
} from "@services/fygaro/webhook-server/fees"
import type { FygaroSettings } from "@services/fygaro/webhook-server/fygaro-settings"

const settings = (overrides: Partial<FygaroSettings> = {}): FygaroSettings => ({
  processor: "Fygaro",
  processorFeePercent: 2.99,
  processorFeeFixed: 0.49,
  flashMarginPercent: 2.0,
  flashMarginFixed: 0,
  autoCreditLimit: 500,
  minimumTopup: 10,
  autoCreditEnabled: true,
  dailyTopupLimits: { 1: 125, 2: 1000, 3: 2500 },
  ...overrides,
})

describe("computeFygaroFees", () => {
  // Each case: gross dollars -> expected processor¢, flash¢, net¢ with the
  // canonical 2.99% + $0.49 processor / 2.0% flash schedule.
  it.each([
    // $10.00 — the reference case from the spec
    [1000, 79, 20, 901],
    // $1.00 — fixed fee dominates
    [100, 52, 2, 46],
    // $500.00 — large, at the auto-credit limit
    [50000, 1544, 1000, 47456],
    // $33.33 — exercises rounding on BOTH percentage components
    // processor: round(3333*2.99/100)=round(99.6567)=100, +49 => 149
    // flash:     round(3333*2/100)=round(66.66)=67
    [3333, 149, 67, 3117],
  ])(
    "gross %i¢ -> processor %i¢, flash %i¢, net %i¢",
    (grossCents, processor, flash, net) => {
      const fees = computeFygaroFees({ grossCents, settings: settings() })
      expect(fees.processorFeeCents).toBe(processor)
      expect(fees.flashFeeCents).toBe(flash)
      expect(fees.netCents).toBe(net)
      expect(fees.grossCents).toBe(grossCents)
      // net must reconcile exactly with the components
      expect(fees.grossCents - fees.processorFeeCents - fees.flashFeeCents).toBe(
        fees.netCents,
      )
    },
  )

  it("rounds each fee component to the nearest cent independently", () => {
    // processorFeeFixed of $0.005 rounds to 1¢ on its own (round(0.5)=1),
    // separately from the percentage component.
    const fees = computeFygaroFees({
      grossCents: 1000,
      settings: settings({
        processorFeePercent: 0,
        processorFeeFixed: 0.005,
        flashMarginPercent: 0,
        flashMarginFixed: 0,
      }),
    })
    expect(fees.processorFeeCents).toBe(1)
    expect(fees.flashFeeCents).toBe(0)
    expect(fees.netCents).toBe(999)
  })

  it("adds the flash fixed margin in cents", () => {
    const fees = computeFygaroFees({
      grossCents: 2000,
      settings: settings({ flashMarginPercent: 2.0, flashMarginFixed: 0.25 }),
    })
    // flash: round(2000*2/100)=40, +round(0.25*100)=25 => 65
    expect(fees.flashFeeCents).toBe(65)
  })
})

describe("evaluateCreditGate", () => {
  const base = {
    creditEnabled: true,
    currency: "USD",
    grossCents: 1000,
    level: 1,
    priorDayGrossCents: 0,
  }

  it("credits with computed fees when every gate holds", () => {
    const gate = evaluateCreditGate({ ...base, settings: settings() })
    expect(gate).toMatchObject({
      credit: true,
      fees: { netCents: 901, processorFeeCents: 79, flashFeeCents: 20 },
    })
  })

  it("record-only: credit-disabled when the deploy master gate is off", () => {
    const gate = evaluateCreditGate({
      ...base,
      creditEnabled: false,
      settings: settings(),
    })
    expect(gate).toEqual({ credit: false, reason: "credit-disabled" })
  })

  it("record-only: settings-unavailable when settings are undefined", () => {
    const gate = evaluateCreditGate({ ...base, settings: undefined })
    expect(gate).toEqual({ credit: false, reason: "settings-unavailable" })
  })

  it("record-only: auto-credit-disabled when the operator toggle is off", () => {
    const gate = evaluateCreditGate({
      ...base,
      settings: settings({ autoCreditEnabled: false }),
    })
    expect(gate).toEqual({ credit: false, reason: "auto-credit-disabled" })
  })

  it("record-only: non-usd for a non-USD currency", () => {
    const gate = evaluateCreditGate({ ...base, currency: "JMD", settings: settings() })
    expect(gate).toEqual({ credit: false, reason: "non-usd" })
  })

  it("record-only: over-limit when gross exceeds the auto-credit limit", () => {
    // $500.01 gross, limit $500
    const gate = evaluateCreditGate({ ...base, grossCents: 50001, settings: settings() })
    expect(gate).toEqual({ credit: false, reason: "over-limit" })
  })

  it("credits exactly at the auto-credit limit (inclusive threshold)", () => {
    // Level 2 so the $1000 daily cap does not shadow the $500 auto-credit limit
    // this test is pinning.
    const gate = evaluateCreditGate({
      ...base,
      grossCents: 50000,
      level: 2,
      settings: settings(),
    })
    expect(gate.credit).toBe(true)
  })

  it("record-only: daily-limit-exceeded when gross plus prior 24h gross tops the level cap", () => {
    // L1 cap $125: $100 charged earlier today + $30 now = $130 > $125.
    const gate = evaluateCreditGate({
      ...base,
      grossCents: 3000,
      priorDayGrossCents: 10000,
      settings: settings(),
    })
    expect(gate).toEqual({ credit: false, reason: "daily-limit-exceeded" })
  })

  it("credits a payment landing exactly ON the daily cap (inclusive)", () => {
    // L1 cap $125: $100 earlier + $25 now = $125 exactly.
    const gate = evaluateCreditGate({
      ...base,
      grossCents: 2500,
      priorDayGrossCents: 10000,
      settings: settings(),
    })
    expect(gate.credit).toBe(true)
  })

  it("uses the cap for the account's own level", () => {
    // $130 total is over the L1 cap but comfortably inside the L2 cap.
    const l1 = evaluateCreditGate({
      ...base,
      grossCents: 3000,
      priorDayGrossCents: 10000,
      level: 1,
      settings: settings(),
    })
    const l2 = evaluateCreditGate({
      ...base,
      grossCents: 3000,
      priorDayGrossCents: 10000,
      level: 2,
      settings: settings(),
    })
    expect(l1).toEqual({ credit: false, reason: "daily-limit-exceeded" })
    expect(l2.credit).toBe(true)
  })

  it("record-only: no-daily-limit-for-level for a level with no configured cap", () => {
    const gate = evaluateCreditGate({ ...base, level: 0, settings: settings() })
    expect(gate).toEqual({ credit: false, reason: "no-daily-limit-for-level" })
  })

  it("record-only: history-unavailable when the trailing-24h read failed", () => {
    const gate = evaluateCreditGate({
      ...base,
      priorDayGrossCents: undefined,
      settings: settings(),
    })
    expect(gate).toEqual({ credit: false, reason: "history-unavailable" })
  })

  it("evaluates gates in order: over-limit wins over the daily-limit gates", () => {
    // $500.01 gross is over BOTH the auto-credit limit and the L1 daily cap;
    // over-limit is checked first. Also proves an over-limit payment never
    // needs the history read (priorDayGrossCents undefined here).
    const gate = evaluateCreditGate({
      ...base,
      grossCents: 50001,
      priorDayGrossCents: undefined,
      settings: settings(),
    })
    expect(gate).toEqual({ credit: false, reason: "over-limit" })
  })

  it("evaluates gates in order: daily-limit-exceeded wins over under-minimum", () => {
    // $5 now with $125 already charged today: below the $10 minimum AND over
    // the L1 cap — the cap (checked first) names the reason.
    const gate = evaluateCreditGate({
      ...base,
      grossCents: 500,
      priorDayGrossCents: 12500,
      settings: settings(),
    })
    expect(gate).toEqual({ credit: false, reason: "daily-limit-exceeded" })
  })

  it("record-only: under-minimum when a positive-net payment is below the minimum", () => {
    // $2.00 gross, $10 minimum: net is positive (~$1.41) but the gross is below
    // the operator minimum, so it must NOT auto-credit.
    const gate = evaluateCreditGate({ ...base, grossCents: 200, settings: settings() })
    expect(gate).toEqual({ credit: false, reason: "under-minimum" })
  })

  it("record-only: under-minimum one cent below the minimum", () => {
    // $9.99 gross vs $10 minimum: still under-minimum (inclusive lower bound).
    const gate = evaluateCreditGate({ ...base, grossCents: 999, settings: settings() })
    expect(gate).toEqual({ credit: false, reason: "under-minimum" })
  })

  it("credits exactly at the minimum top-up (inclusive lower bound)", () => {
    // $10.00 gross == $10 minimum: credits.
    const gate = evaluateCreditGate({ ...base, grossCents: 1000, settings: settings() })
    expect(gate.credit).toBe(true)
  })

  it("record-only: non-positive-net when fees meet or exceed gross", () => {
    // $0.10 gross, $0.49 fixed processor fee => net is negative
    const gate = evaluateCreditGate({ ...base, grossCents: 10, settings: settings() })
    expect(gate).toEqual({ credit: false, reason: "non-positive-net" })
  })

  it("evaluates gates in order: non-positive-net wins over under-minimum", () => {
    // $0.10 gross is BOTH below the $10 minimum and non-positive-net. The net
    // gate is checked first, so the more fundamental reason is reported.
    const gate = evaluateCreditGate({ ...base, grossCents: 10, settings: settings() })
    expect(gate).toEqual({ credit: false, reason: "non-positive-net" })
  })

  it("evaluates gates in order: master gate wins over everything", () => {
    const gate = evaluateCreditGate({
      ...base,
      creditEnabled: false,
      currency: "JMD",
      settings: undefined,
    })
    expect(gate).toEqual({ credit: false, reason: "credit-disabled" })
  })

  it("evaluates gates in order: settings-unavailable wins over non-usd", () => {
    const gate = evaluateCreditGate({ ...base, currency: "JMD", settings: undefined })
    expect(gate).toEqual({ credit: false, reason: "settings-unavailable" })
  })
})

describe("flash-fee discount", () => {
  // $10.00 gross with the canonical schedule: processor 79¢, full flash 20¢.
  it.each([
    // discount% -> expected flash¢, net¢
    [0, 20, 901],
    [25, 15, 906], // round(20 * 0.75) = 15
    [50, 10, 911],
    [100, 0, 921], // full waiver: net = gross - processor only
  ])("discounts the flash fee by %i%%", (discount, flash, net) => {
    const fees = computeFygaroFees({
      grossCents: 1000,
      settings: settings(),
      flashFeeDiscountPercent: discount,
    })
    expect(fees.processorFeeCents).toBe(79) // never discounted
    expect(fees.flashFeeCents).toBe(flash)
    expect(fees.netCents).toBe(net)
  })

  it("discounts the fixed flash margin component too", () => {
    // 2% + $0.50 fixed on $10.00 = 20¢ + 50¢ = 70¢ full flash fee; 50% -> 35¢.
    const fees = computeFygaroFees({
      grossCents: 1000,
      settings: settings({ flashMarginFixed: 0.5 }),
      flashFeeDiscountPercent: 50,
    })
    expect(fees.flashFeeCents).toBe(35)
  })

  it("supports fractional discount percentages", () => {
    // $500.00 gross -> full flash fee 1000¢; 12.5% off -> round(875) = 875¢.
    const fees = computeFygaroFees({
      grossCents: 50000,
      settings: settings(),
      flashFeeDiscountPercent: 12.5,
    })
    expect(fees.flashFeeCents).toBe(875)
  })

  it("clamps out-of-range discounts so garbage can never inflate the fee", () => {
    const negative = computeFygaroFees({
      grossCents: 1000,
      settings: settings(),
      flashFeeDiscountPercent: -50,
    })
    expect(negative.flashFeeCents).toBe(20) // treated as 0%
    const over = computeFygaroFees({
      grossCents: 1000,
      settings: settings(),
      flashFeeDiscountPercent: 250,
    })
    expect(over.flashFeeCents).toBe(0) // treated as 100%
  })

  it("flows through evaluateCreditGate into the credited fees", () => {
    const base = {
      creditEnabled: true,
      currency: "USD",
      grossCents: 1000,
      level: 1,
      priorDayGrossCents: 0,
    }
    const gate = evaluateCreditGate({
      ...base,
      settings: settings(),
      flashFeeDiscountPercent: 100,
    })
    expect(gate).toMatchObject({
      credit: true,
      fees: { netCents: 921, processorFeeCents: 79, flashFeeCents: 0 },
    })
  })

  it("can rescue a non-positive-net payment (fee waiver makes the net positive)", () => {
    // $0.60 gross: processor round(60*2.99/100)+49 = 51¢, full flash 1¢ ->
    // net 8¢ ... still positive; use flashMarginFixed to force it negative.
    // 2% + $0.10 fixed on $0.60 = 1¢ + 10¢ = 11¢ flash; net 60-51-11 = -2¢.
    const base = {
      creditEnabled: true,
      currency: "USD",
      grossCents: 60,
      level: 1,
      priorDayGrossCents: 0,
    }
    const withFee = evaluateCreditGate({
      ...base,
      settings: settings({ flashMarginFixed: 0.1, minimumTopup: 0.1 }),
    })
    expect(withFee).toEqual({ credit: false, reason: "non-positive-net" })

    const waived = evaluateCreditGate({
      ...base,
      settings: settings({ flashMarginFixed: 0.1, minimumTopup: 0.1 }),
      flashFeeDiscountPercent: 100,
    })
    expect(waived).toMatchObject({ credit: true, fees: { netCents: 9 } })
  })
})
