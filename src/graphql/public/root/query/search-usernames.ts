import { AuthenticationError, UserInputError } from "apollo-server-errors"

import { searchUsernames } from "@app/accounts/search-usernames"
import { normalizeUsernameSearch } from "@domain/accounts/username-search"
import { RateLimitConfig } from "@domain/rate-limit"
import { GT } from "@graphql/index"
import { mapError } from "@graphql/error-map"
import Username from "@graphql/shared/types/scalar/username"
import { consumeLimiter } from "@services/rate-limit"

const SearchUsernamesQuery = GT.Field({
  type: GT.NonNullList(Username),
  extensions: { complexity: 120 },
  args: { query: { type: GT.NonNull(GT.String) } },
  description:
    "Up to five similar public Flash usernames, including people outside your contacts. Requires 3–50 letters, digits or underscores after removing spaces. Uses bounded prefix and spelling searches; results require recipient verification and selection.",
  resolve: async (
    _,
    { query }: { query: string },
    { domainAccount }: GraphQLPublicContextAuth,
  ) => {
    if (!domainAccount?.id)
      throw new AuthenticationError("Sign in to search Flash usernames.")
    if (!normalizeUsernameSearch(query))
      throw new UserInputError(
        "Enter at least three username characters, using letters, numbers or underscores.",
      )
    const limited = await consumeLimiter({
      rateLimitConfig: RateLimitConfig.usernameSearch,
      keyToConsume: domainAccount.id,
    })
    if (limited instanceof Error) throw mapError(limited)
    const result = await searchUsernames(query)
    if (result instanceof Error) throw mapError(result)
    return result
  },
})
export default SearchUsernamesQuery
