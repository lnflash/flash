import { MAX_CENTS } from "@domain/shared"
import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"

const FractionalCentAmount = GT.Scalar({
  name: "FractionalCentAmount",
  description: "Cent amount (1/100 of a dollar) as a float, can be positive or negative",
  parseValue(value) {
    if (typeof value !== "string" && typeof value !== "number") {
      return new InputValidationError({ message: "Invalid type for FractionalCentAmount" })
    }
    return validFractionalCentAmount(value)
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.INT || ast.kind === GT.Kind.FLOAT) {
      return validFractionalCentAmount(ast.value)
    }
    return new InputValidationError({ message: "Invalid type for FractionalCentAmount" })
  },
})

function validFractionalCentAmount(value: string | number) {
  let floatValue: number
  if (typeof value === "number") {
    floatValue = value
  } else {
    floatValue = Number.parseFloat(value)
  }

  if (!Number.isFinite(floatValue)) {
    return new InputValidationError({ message: "Invalid value for FractionalCentAmount" })
  }

  const maxCents = Number(MAX_CENTS.amount)
  if (floatValue > maxCents || floatValue < -maxCents) {
    return new InputValidationError({ message: "Value out of range for FractionalCentAmount" })
  }

  return floatValue
}

export default FractionalCentAmount
