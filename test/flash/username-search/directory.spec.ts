import mongoose from "mongoose"

import { AccountStatus } from "@domain/accounts"
import { rankUsernameSearch } from "@domain/accounts/username-search"
import { Account } from "@services/mongoose/schema"
import { searchUsernameCandidates } from "@services/mongoose/username-search"

// Dedicated empty database only. Never run against an application's account database.
const uri = process.env.USERNAME_SEARCH_TEST_URI
if (!uri || !/\/username_search_test(?:\?|$)/.test(uri))
  throw new Error(
    "USERNAME_SEARCH_TEST_URI must name the isolated username_search_test database",
  )

const plans: unknown[] = []
const find = Account.find.bind(Account)

describe("public username search against MongoDB", () => {
  beforeAll(async () => {
    await mongoose.connect(uri)
    await mongoose.connection.dropDatabase()
    await Account.init()
    const row = (username: string, extra = {}) => ({
      username,
      contactEnabled: true,
      npub: "npub1" + username.padEnd(58, "a"),
      statusHistory: [{ status: AccountStatus.Active }],
      ...extra,
    })
    await Account.collection.insertMany([
      ...Array.from({ length: 1000 }, (_, i) => row(`person${i}`)),
      ...[
        "dreadmax",
        "dreadmark",
        "dreadmarie",
        "dreadmaster",
        "dreadmath",
        "dreadmate",
        "maria_s",
        "ALICE",
      ].map((name) => row(name)),
      row("dreadprivate", { contactEnabled: false }),
      row("dreadclosed", {
        statusHistory: [
          { status: AccountStatus.Active },
          { status: AccountStatus.Locked },
        ],
      }),
      row("dreadinternal", { npub: null }),
    ])
    // Explain the actual service's queries, including its projection, collation and hint.
    jest.spyOn(Account, "find").mockImplementation((...args: Parameters<typeof find>) => {
      const query = find(...args)
      const lean = query.lean.bind(query)
      query.lean = (async () => {
        plans.push(await query.clone().explain("executionStats"))
        return lean()
      }) as typeof query.lean
      return query
    })
  }, 30000)
  afterAll(async () => {
    jest.restoreAllMocks()
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })
  const search = async (hint: string) => {
    const result = await searchUsernameCandidates(hint)
    if (result instanceof Error) throw result
    return rankUsernameSearch(hint, result)
  }
  it("finds strangers by prefix and an initial-character typo, capped at five", async () => {
    expect(await search("dreadma")).toHaveLength(5)
    expect(await search("treadmax")).toContain("dreadmax")
    expect(await search("dreadmxa")).toContain("dreadmax")
    expect(await search("alice")).toContain("ALICE")
  })
  it("excludes internal, disabled and closed accounts and unrelated names", async () => {
    const result = await search("dread")
    expect(result).not.toEqual(
      expect.arrayContaining(["dreadprivate", "dreadclosed", "dreadinternal"]),
    )
    expect(await search("flashbacks")).toEqual([])
  })
  it("uses the existing username index without a collection scan for every branch", () => {
    expect(plans.length).toBeGreaterThanOrEqual(18)
    for (const plan of plans) {
      const json = JSON.stringify(plan)
      expect(json).toContain('"stage":"IXSCAN"')
      expect(json).not.toContain('"stage":"COLLSCAN"')
    }
  })
})
