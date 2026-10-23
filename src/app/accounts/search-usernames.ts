import { InvalidUsername } from "@domain/errors"
import {
  normalizeUsernameSearch,
  rankUsernameSearch,
} from "@domain/accounts/username-search"
import { searchUsernameCandidates } from "@services/mongoose/username-search"

export const searchUsernames = async (
  query: string,
): Promise<string[] | ApplicationError> => {
  const hint = normalizeUsernameSearch(query)
  if (!hint) return new InvalidUsername(query)
  const candidates = await searchUsernameCandidates(hint)
  return candidates instanceof Error ? candidates : rankUsernameSearch(hint, candidates)
}
