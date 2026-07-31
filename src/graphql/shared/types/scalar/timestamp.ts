import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"

type InternalDate = Date
type ExternalDate = number | InputValidationError

// A pure-digit string is Unix seconds; anything else must be a parseable date
// string (e.g. ISO-8601). `parseInt("2026-07-30T…")` would silently yield 2026
// (≈1970 as epoch seconds), which once corrupted an admin-supplied scheduledAt.
const parseDateString = (value: string): Date | InputValidationError => {
  if (/^\d+$/.test(value)) {
    return new Date(parseInt(value, 10) * 1000) // Unix seconds -> ms
  }
  const date = new Date(value)
  if (isNaN(date.getTime())) {
    return new InputValidationError({ message: "Invalid timestamp value" })
  }
  return date
}

const Timestamp = GT.Scalar<InternalDate | InputValidationError, ExternalDate>({
  name: "Timestamp",
  description:
    "Timestamp field, serialized as Unix time (the number of seconds since the Unix epoch)",
  serialize(value) {
    if (value instanceof Date) {
      return Math.floor(value.getTime() / 1000)
    }
    if (typeof value === "number") {
      return value
    }
    return new InputValidationError({ message: "Invalid value for Date" })
  },
  parseValue(value) {
    if (typeof value === "number") {
      return new Date(value * 1000) // Unix seconds -> ms
    }
    if (typeof value === "string") {
      return parseDateString(value)
    }
    return new InputValidationError({ message: "Invalid type for Date" })
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.INT) {
      return new Date(parseInt(ast.value, 10) * 1000) // Unix seconds -> ms
    }
    if (ast.kind === GT.Kind.STRING) {
      return parseDateString(ast.value)
    }
    return new InputValidationError({ message: "Invalid type for Date" })
  },
})

// TODO: validate date value

export default Timestamp
