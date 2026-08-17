/**
 * The two ERPNext field coercions are shared by every raw-doctype reader
 * (fee-discounts, fygaro-settings). They used to be copy-pasted per reader;
 * these cases pin the contract in one place so teaching one reader a new
 * encoding cannot silently diverge from the other.
 */
import { toBoolean, toFiniteNumber } from "@services/frappe/coerce"

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
