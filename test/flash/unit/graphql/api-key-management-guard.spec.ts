import ApiKeyCreateMutation from "@graphql/public/root/mutation/api-key-create"
import ApiKeyRevokeMutation from "@graphql/public/root/mutation/api-key-revoke"
import ApiKeyRotateMutation from "@graphql/public/root/mutation/api-key-rotate"
import ApiKeysQuery from "@graphql/public/root/query/api-keys"

jest.mock("@app/api-keys", () => ({
  createApiKey: jest.fn(),
  revokeApiKey: jest.fn(),
  rotateApiKey: jest.fn(),
  listApiKeys: jest.fn(),
}))

const apiKeyContext = {
  domainAccount: { id: "account-id" as AccountId },
  sessionId: "apikey:8e8b4f60" as SessionId,
} as unknown as GraphQLPublicContextAuth

const mutations = [
  ["apiKeyCreate", ApiKeyCreateMutation, { input: { name: "x", scopes: ["read:user"] } }],
  ["apiKeyRevoke", ApiKeyRevokeMutation, { input: { id: "some-id" } }],
  ["apiKeyRotate", ApiKeyRotateMutation, { input: { id: "some-id" } }],
] as const

describe("api-key management is rejected for API-key sessions", () => {
  it.each(mutations)("%s returns an error payload", async (_name, field, args) => {
    const resolve = field.resolve as (
      source: unknown,
      args: unknown,
      ctx: GraphQLPublicContextAuth,
    ) => Promise<{ errors: { message: string }[]; apiKey: unknown }>

    const result = await resolve({}, args, apiKeyContext)

    expect(result.apiKey).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/API key/i)
  })

  it("apiKeys query throws", async () => {
    const resolve = ApiKeysQuery.resolve as (
      source: unknown,
      args: unknown,
      ctx: GraphQLPublicContextAuth,
    ) => Promise<unknown>

    await expect(resolve({}, {}, apiKeyContext)).rejects.toThrow(
      /API keys cannot be managed/,
    )
  })
})
