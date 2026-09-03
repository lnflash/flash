/**
 * The ERPNext field coercions are shared by every raw-doctype reader
 * (fee-discounts, fygaro-settings, allowed-countries). They used to be
 * copy-pasted per reader; these cases pin the contract in one place so
 * teaching one reader a new encoding cannot silently diverge from the other.
 */
import { toAlpha2, toBoolean, toFiniteNumber } from "@services/frappe/coerce"

describe("toFiniteNumber", () => {
  it.each([
    [12.5, 12.5],
    [0, 0],
    [-3, -3],
    ["12.5", 12.5],
    ["  7 ", 7],
  ])("coerces %p to %p", (input, expected) => {
    expect(toFiniteNumber(input)).toBe(expected)
  })

  it.each([
    ["a blank string", "   "],
    ["an empty string", ""],
    ["a non-numeric string", "abc"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["an object", {}],
    // A boolean is NOT silently 1/0 here — a Check field read as a number is a
    // schema mistake the caller should reject, not paper over.
    ["a boolean", true],
  ])("returns undefined for %s", (_label, input) => {
    expect(toFiniteNumber(input)).toBeUndefined()
  })
})

describe("toBoolean", () => {
  it.each([[1], [true], ["1"]])("treats %p as true", (input) => {
    expect(toBoolean(input)).toBe(true)
  })

  it.each([
    ["0", 0],
    ['"0"', "0"],
    ["false", false],
    ["null", null],
    ["undefined", undefined],
    // Unrecognized encodings are false: a Check field ERPNext never emits this
    // way must not turn a discount (or an auto-credit toggle) on by accident.
    ['"true"', "true"],
    ['"Yes"', "Yes"],
  ])("treats %s as false", (_label, input) => {
    expect(toBoolean(input)).toBe(false)
  })
})

// One rule for every place a country code enters the system: an ERPNext row,
// a config list entry, a Twilio Lookup result, a parsed phone number. The
// Bridge KYC gate and the Allowed Country reader both call this, so a code
// that passes one cannot fail the other.
describe("toAlpha2", () => {
  it.each([
    ["JM", "JM"],
    ["jm", "JM"],
    ["  us ", "US"],
    ["Gb", "GB"],
  ])("normalises %p to %p", (input, expected) => {
    expect(toAlpha2(input)).toBe(expected)
  })

  it.each([
    ["an empty string", ""],
    ["a blank string", "   "],
    ["an alpha-3 code", "JAM"],
    ["a single letter", "J"],
    ["a digit", "J1"],
    ["a calling code", "+1"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
    ["an object", {}],
  ])("returns undefined for %s", (_label, input) => {
    expect(toAlpha2(input)).toBeUndefined()
  })
})
