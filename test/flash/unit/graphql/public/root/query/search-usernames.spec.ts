import { GraphQLObjectType, GraphQLSchema, parse } from "graphql"
import {
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator,
} from "graphql-query-complexity"
import { MAXIMUM_QUERY_COMPLEXITY } from "@servers/plugins/complexity"
import SearchUsernamesQuery from "@graphql/public/root/query/search-usernames"
import { UsernameSearchRateLimiterExceededError } from "@domain/rate-limit/errors"
const search = jest.fn(),
  consume = jest.fn()
jest.mock("@app/accounts/search-usernames", () => ({
  searchUsernames: (...args: unknown[]) => search(...args),
}))
jest.mock("@services/rate-limit", () => ({
  consumeLimiter: (...args: unknown[]) => consume(...args),
}))

const resolve = (query: string, account = { id: "account-a" }) => {
  const field = SearchUsernamesQuery as unknown as {
    resolve: (
      source: null,
      args: { query: string },
      context: unknown,
    ) => Promise<string[]>
  }
  return field.resolve(null, { query }, { domainAccount: account })
}
describe("searchUsernames GraphQL boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    consume.mockResolvedValue(true)
    search.mockResolvedValue(["dreadmax"])
  })
  it("consumes the caller's own budget before searching", async () => {
    expect(await resolve("dreadma")).toEqual(["dreadmax"])
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({
        keyToConsume: "account-a",
        rateLimitConfig: expect.objectContaining({ key: "username_search" }),
      }),
    )
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(
      search.mock.invocationCallOrder[0],
    )
  })
  it("refuses unauthed or invalid input before any store access", async () => {
    await expect(resolve("dre*", { id: "account-a" })).rejects.toThrow(
      "Enter at least three",
    )
    expect(search).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
    await expect(resolve("dreadma", {} as never)).rejects.toThrow("Sign in")
    expect(search).not.toHaveBeenCalled()
  })
  it("refuses rate-limited searches without running the database read", async () => {
    consume.mockResolvedValue(new UsernameSearchRateLimiterExceededError())
    await expect(resolve("dreadma")).rejects.toThrow("Too many username searches")
    expect(search).not.toHaveBeenCalled()
  })
  it("does not turn a limiter-store failure into no search results", async () => {
    consume.mockResolvedValue(new Error("redis unavailable"))
    await expect(resolve("dreadma")).rejects.toThrow()
    expect(search).not.toHaveBeenCalled()
  })
  it("accepts one search but rejects two aliased searches under the server's complexity limit", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: { searchUsernames: SearchUsernamesQuery },
      }),
    })
    const complexity = (text: string) =>
      getComplexity({
        schema,
        query: parse(text),
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
      })
    expect(complexity('{ searchUsernames(query: "alice") }')).toBeLessThanOrEqual(
      MAXIMUM_QUERY_COMPLEXITY,
    )
    expect(
      complexity(
        '{ a: searchUsernames(query: "alice") b: searchUsernames(query: "bob") }',
      ),
    ).toBeGreaterThan(MAXIMUM_QUERY_COMPLEXITY)
  })
})
