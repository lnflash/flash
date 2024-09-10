import { checkValidNpub } from "@app/accounts"
import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"

const Npub = GT.Scalar({
  name: "npub",
  description: "Nostr Identity public key",
  parseValue(value) {
    if (typeof value !== "string") {
      return new InputValidationError({ message: "Invalid type for Npub" })
    } else if (!checkValidNpub(value))
      return new InputValidationError({ message: "Invalid value for Npub" })
    return value.toString()
  },
  parseLiteral(ast) {
    if (ast.kind !== GT.Kind.STRING)
      return new InputValidationError({ message: "Invalid type for Npub" })
    else if (!checkValidNpub(ast.value))
      return new InputValidationError({ message: "Invalid value for Npub" })
    else ast.value.toLowerCase()
  },
})

export default Npub
