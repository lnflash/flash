import { MAX_CENTS } from "@domain/shared"
import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"

const FractionalCentAmount = GT.Scalar({
  name: "FractionalCentAmount",
  description: "(Positive) Cent amount (1/100 of a dollar) as a float",
  parseValue(value) {
    if (typeof value !== "string" && typeof value !== "number") {
      return new InputValidationError({ message: "Invalid type for FractionalCentAmount" })
    }
    return validFractionalCentAmount(value)
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.INT) {
      return validFractionalCentAmount(ast.value)
    }
    return new InputValidationError({ message: "Invalid type for FractionalCentAmount" })
  },
})

function validFractionalCentAmount(value: string | number) {
  let intValue: number
  if (typeof value === "number") {
    intValue = value
  } else {
    intValue = Number.parseFloat(value) 
  }

  if (!(intValue >= 0)) {
    return new InputValidationError({ message: "Invalid value for FractionalCentAmount" })
  }

  if (intValue > MAX_CENTS.amount) {
    return new InputValidationError({ message: "Value too big for FractionalCentAmount" })
  }

  return intValue
}

export default FractionalCentAmount
