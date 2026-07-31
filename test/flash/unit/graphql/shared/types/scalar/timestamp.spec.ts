import { Kind } from "graphql"

import { InputValidationError } from "@graphql/error"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

describe("Timestamp scalar", () => {
  it("serializes a Date as Unix seconds", () => {
    expect(Timestamp.serialize(new Date("2026-07-30T12:00:00Z"))).toBe(1785412800)
  })

  it("parses a numeric value as Unix seconds", () => {
    expect(Timestamp.parseValue(1785412800)).toEqual(new Date("2026-07-30T12:00:00Z"))
  })

  it("parses a pure-digit string as Unix seconds", () => {
    expect(Timestamp.parseValue("1785412800")).toEqual(new Date("2026-07-30T12:00:00Z"))
  })

  it("parses an ISO-8601 string as that date — not as parseInt seconds", () => {
    // Regression: parseInt("2026-07-30T…") === 2026 silently produced a 1970
    // date, corrupting admin-supplied values like cutover scheduledAt.
    expect(Timestamp.parseValue("2026-07-30T12:00:00Z")).toEqual(
      new Date("2026-07-30T12:00:00Z"),
    )
  })

  it("rejects an unparsable date string", () => {
    expect(Timestamp.parseValue("not-a-date")).toBeInstanceOf(InputValidationError)
  })

  it("parses INT and STRING literals consistently", () => {
    expect(Timestamp.parseLiteral({ kind: Kind.INT, value: "1785412800" }, null)).toEqual(
      new Date("2026-07-30T12:00:00Z"),
    )
    expect(
      Timestamp.parseLiteral({ kind: Kind.STRING, value: "2026-07-30T12:00:00Z" }, null),
    ).toEqual(new Date("2026-07-30T12:00:00Z"))
  })
})
