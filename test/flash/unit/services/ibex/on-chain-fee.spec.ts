import { UnexpectedIbexResponse } from "@services/ibex/errors"
import { onChainFeeCentsFromIbex } from "@services/ibex/on-chain-fee"

describe("onChainFeeCentsFromIbex", () => {
  it("turns IBEX's dollar fee into cents: the answer production gave", () => {
    // 686 sats at about $59,600 a bitcoin is 41 cents, and IBEX says 0.4099.
    const cents = onChainFeeCentsFromIbex({ fee: 0.409916881285, feeSat: 686 } as {
      fee?: unknown
    })

    expect(cents).toBeCloseTo(40.9916881285, 6)
  })

  it("is one hundred times the dollar figure, never the figure itself", () => {
    expect(onChainFeeCentsFromIbex({ fee: 0.36 })).toBe(36)
    expect(onChainFeeCentsFromIbex({ fee: 1 })).toBe(100)
    expect(onChainFeeCentsFromIbex({ fee: 12.5 })).toBe(1250)
  })

  it("drops the float noise the multiplication adds", () => {
    // 0.57 * 100 is 56.99999999999999 in floating point.
    expect(onChainFeeCentsFromIbex({ fee: 0.57 })).toBe(57)
    expect(onChainFeeCentsFromIbex({ fee: 0.29 })).toBe(29)
  })

  it("keeps fractions of a cent", () => {
    expect(onChainFeeCentsFromIbex({ fee: 0.001109 })).toBe(0.1109)
  })

  it("passes a zero fee through as zero, not as a missing fee", () => {
    expect(onChainFeeCentsFromIbex({ fee: 0 })).toBe(0)
  })

  it.each([
    ["absent", {}],
    ["undefined", { fee: undefined }],
    ["null", { fee: null }],
  ])("reports a missing fee when the field is %s", (_, resp) => {
    const result = onChainFeeCentsFromIbex(resp)

    expect(result).toBeInstanceOf(UnexpectedIbexResponse)
    expect((result as Error).message).toContain("Missing fee field")
  })

  it.each([
    ["a string", "0.41"],
    ["NaN", NaN],
    ["infinite", Infinity],
    ["negative", -0.41],
    ["an object", { amount: 0.41 }],
  ])("refuses a fee that is %s instead of guessing", (_, fee) => {
    const result = onChainFeeCentsFromIbex({ fee })

    expect(result).toBeInstanceOf(UnexpectedIbexResponse)
    expect((result as Error).message).toContain("Invalid fee field")
  })
})
