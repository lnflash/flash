import { ErrorLevel, MAX_SATS } from "@domain/shared"
import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"
import { recordExceptionInCurrentSpan } from "@services/tracing"

const JmdCentAmount = GT.Scalar({
  name: "JmdCentAmount",
  description: "(Positive) Jamaican Cent amount (1/100 of a Jamaican dollar)",
  parseValue(value) {
    if (typeof value !== "string" && typeof value !== "number") {
      return new InputValidationError({ message: "Invalid type for JmdCentAmount" })
    }
    return validJmdCentAmount(value)
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.INT) {
      return validJmdCentAmount(ast.value)
    }
    return new InputValidationError({ message: "Invalid type for JmdCentAmount" })
  },
})

function validJmdCentAmount(value: string | number) {
  let intValue: number
  if (typeof value === "number") {
    // TODO: remove trunc and recordExceptionInCurrentSpan once mobile app is fixed
    intValue = Math.trunc(value)
    if (!Number.isInteger(value)) {
      recordExceptionInCurrentSpan({
        error: new InputValidationError({ message: "Float value for JmdCentAmount" }),
        level: ErrorLevel.Warn,
      })
    }
  } else {
    intValue = Number.parseInt(value, 10)
  }

  if (!(Number.isInteger(intValue) && intValue >= 0)) {
    return new InputValidationError({ message: "Invalid value for JmdCentAmount" })
  }

  if (intValue > MAX_SATS.amount) {
    return new InputValidationError({ message: "Value too big for JmdCentAmount" })
  }

  return intValue
}

export default JmdCentAmount
