import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"

const AccountNumber = GT.Scalar({
  name: "AccountNumber",
  description: "Bank account number. Accepts String or Int and coerces to String.",
  serialize(value) {
    return String(value)
  },
  parseValue(value) {
    if (typeof value === "string") return value
    if (typeof value === "number" && Number.isInteger(value)) return String(value)
    return new InputValidationError({ message: "Invalid type for AccountNumber" })
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.STRING) return ast.value
    if (ast.kind === GT.Kind.INT) return ast.value
    return new InputValidationError({ message: "Invalid type for AccountNumber" })
  },
})

export default AccountNumber
