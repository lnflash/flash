import { AccountStatus } from "@domain/accounts"
import {
  USERNAME_SEARCH_SCAN_LIMIT,
  usernameSearchVariants,
} from "@domain/accounts/username-search"
import { RepositoryError } from "@domain/errors"

import { Account } from "./schema"
import { parseRepositoryError } from "./utils"

/** All branches use the existing case-insensitive username index, with bounded reads. */
export const searchUsernameCandidates = async (
  query: string,
): Promise<string[] | RepositoryError> => {
  const read = async (username: Record<string, unknown>, limit: number) => {
    const rows = await Account.find(
      {
        username: { ...username, $type: "string" },
        npub: { $type: "string" },
        contactEnabled: true,
        $expr: { $eq: [{ $last: "$statusHistory.status" }, AccountStatus.Active] },
      },
      { _id: 0, username: 1 },
    )
      .collation({ locale: "en", strength: 2 })
      .hint({ username: 1 })
      .sort({ username: 1 })
      .limit(limit)
      .maxTimeMS(250)
      .lean()
    return rows.flatMap((row) => (typeof row.username === "string" ? [row.username] : []))
  }
  try {
    const prefix = [...query].slice(0, 3).join("")
    const results = await Promise.all([
      read({ $in: usernameSearchVariants(query) }, 20),
      read({ $gte: query, $lt: query + "\uffff" }, 20),
      read({ $gte: prefix, $lt: prefix + "\uffff" }, USERNAME_SEARCH_SCAN_LIMIT),
    ])
    return [...new Set(results.flat())]
  } catch (error) {
    return parseRepositoryError(error)
  }
}
