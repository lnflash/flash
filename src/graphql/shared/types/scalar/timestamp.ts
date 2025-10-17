import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"

type InternalDate = Date
type ExternalDate = number | InputValidationError

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
    if (typeof value === "string" || typeof value === "number") {
      // Parse as Unix timestamp (seconds since epoch)
      const timestamp = typeof value === "string" ? parseInt(value, 10) : value
      if (isNaN(timestamp)) {
        return new InputValidationError({ message: "Invalid timestamp value" })
      }
      return new Date(timestamp * 1000) // Convert seconds to milliseconds
    }
    return new InputValidationError({ message: "Invalid type for Date" })
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.STRING || ast.kind === GT.Kind.INT) {
      const timestamp = parseInt(ast.value, 10)
      if (isNaN(timestamp)) {
        return new InputValidationError({ message: "Invalid timestamp value" })
      }
      return new Date(timestamp * 1000) // Convert seconds to milliseconds
    }
    return new InputValidationError({ message: "Invalid type for Date" })
  },
})

// TODO: validate date value

export default Timestamp
