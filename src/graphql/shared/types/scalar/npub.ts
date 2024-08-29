import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"

const Npub = GT.Scalar({
  name: "npub",
  description: "Nostr Identity public key",
  parseValue(value) {
    if (typeof value !== "string") {
      return new InputValidationError({ message: "Invalid type for Npub" })
    }
    return validNpubValue(value)
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.STRING) {
      return validNpubValue(ast.value)
    }
    return new InputValidationError({ message: "Invalid type for Npub" })
  },
})

function validNpubValue(value: string) {
  if (value.startsWith("npub1") && value.length === 63) {
    return value.toLowerCase()
  }
  return new InputValidationError({ message: "Invalid value for Npub" })
}

export default Npub
