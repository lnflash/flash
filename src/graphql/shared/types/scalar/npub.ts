import { checkValidNpub } from "@domain/nostr"
import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"

const Npub = GT.Scalar({
  name: "npub",
  description: "Nostr Identity public key",
  // Both coercion paths must normalise identically: bech32 npubs are a
  // lowercase-only charset, so lowercasing here is what lets the repository
  // query be a plain, index-backed `$eq` with no collation.
  parseValue(value) {
    if (typeof value !== "string") {
      return new InputValidationError({ message: "Invalid type for Npub" })
    } else if (!checkValidNpub(value))
      return new InputValidationError({ message: "Invalid value for Npub" })
    return value.toLowerCase()
  },
  parseLiteral(ast) {
    if (ast.kind !== GT.Kind.STRING)
      return new InputValidationError({ message: "Invalid type for Npub" })
    else if (!checkValidNpub(ast.value))
      return new InputValidationError({ message: "Invalid value for Npub" })
    // NOTE: the `return` is load-bearing. graphql-js reads `undefined` from
    // parseLiteral as failed coercion, so dropping it rejects every valid
    // inline-literal npub at validation time.
    else return ast.value.toLowerCase()
  },
})

export default Npub
