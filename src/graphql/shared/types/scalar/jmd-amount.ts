import { ErrorLevel, MAX_SATS } from "@domain/shared"
import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"
import { recordExceptionInCurrentSpan } from "@services/tracing"

const JmdAmount = GT.Scalar({
  name: "JmdAmount",
  description: "(Positive) Jamaican dollar amount",
  parseValue(value) {
    if (typeof value !== "string" && typeof value !== "number") {
      return new InputValidationError({ message: "Invalid type for JmdAmount" })
    }
    return validJmdAmount(value)
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.INT) {
      return validJmdAmount(ast.value)
    }
    return new InputValidationError({ message: "Invalid type for JmdAmount" })
  },
})

function validJmdAmount(value: string | number) {
  let intValue: number
  if (typeof value === "number") {
    // TODO: remove trunc and recordExceptionInCurrentSpan once mobile app is fixed
    intValue = Math.trunc(value)
    if (!Number.isInteger(value)) {
      recordExceptionInCurrentSpan({
        error: new InputValidationError({ message: "Float value for JmdAmount" }),
        level: ErrorLevel.Warn,
      })
    }
  } else {
    intValue = Number.parseInt(value, 10)
  }

  if (!(Number.isInteger(intValue) && intValue >= 0)) {
    return new InputValidationError({ message: "Invalid value for JmdAmount" })
  }

  if (intValue > MAX_SATS.amount) {
    return new InputValidationError({ message: "Value too big for JmdAmount" })
  }

  return intValue
}

export default JmdAmount
