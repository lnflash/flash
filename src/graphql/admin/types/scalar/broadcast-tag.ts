import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"
import { checkedToBroadcastTag } from "@domain/notifications"

const BroadcastTag = GT.Scalar({
  name: "BroadcastTag",
  parseValue(value) {
    if (typeof value !== "string") {
      return new InputValidationError({
        message: "Invalid type for BroadcastTag",
      })
    }
    return validBroadcastTag(value)
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.STRING) {
      return validBroadcastTag(ast.value)
    }
    return new InputValidationError({ message: "Invalid type for BroadcastTag" })
  },
})

function validBroadcastTag(value: string): BroadcastTag | InputValidationError {
  const checkedTag = checkedToBroadcastTag(value)
  if (checkedTag instanceof Error) {
    return new InputValidationError({ message: checkedTag.message })
  }
  return checkedTag
}

export default BroadcastTag
