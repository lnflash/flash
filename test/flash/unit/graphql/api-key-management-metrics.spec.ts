import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "@app/api-keys"
import { MaxApiKeysPerAccountError } from "@domain/api-keys"
import ApiKeyCreateMutation from "@graphql/public/root/mutation/api-key-create"
import ApiKeyRevokeMutation from "@graphql/public/root/mutation/api-key-revoke"
import ApiKeyRotateMutation from "@graphql/public/root/mutation/api-key-rotate"
import ApiKeysQuery from "@graphql/public/root/query/api-keys"
import { incApiKeyManagement } from "@services/api-keys-metrics"

jest.mock("@app/api-keys", () => ({
  createApiKey: jest.fn(),
  revokeApiKey: jest.fn(),
  rotateApiKey: jest.fn(),
  listApiKeys: jest.fn(),
}))

jest.mock("@services/api-keys-metrics", () => ({
  incApiKeyManagement: jest.fn(),
}))

const mockedCreate = createApiKey as jest.MockedFunction<typeof createApiKey>
const mockedRevoke = revokeApiKey as jest.MockedFunction<typeof revokeApiKey>
const mockedRotate = rotateApiKey as jest.MockedFunction<typeof rotateApiKey>
const mockedList = listApiKeys as jest.MockedFunction<typeof listApiKeys>
const mockedInc = incApiKeyManagement as jest.MockedFunction<typeof incApiKeyManagement>

const kratosContext = {
  domainAccount: { id: "account-id" as AccountId },
  sessionId: "9f8e7d6c-kratos-session" as SessionId,
} as unknown as GraphQLPublicContextAuth

const apiKeyContext = {
  domainAccount: { id: "account-id" as AccountId },
  sessionId: "apikey:8e8b4f60" as SessionId,
} as unknown as GraphQLPublicContextAuth

type Resolver = (
  source: unknown,
  args: unknown,
  ctx: GraphQLPublicContextAuth,
) => Promise<unknown>

const createResolve = ApiKeyCreateMutation.resolve as Resolver
const revokeResolve = ApiKeyRevokeMutation.resolve as Resolver
const rotateResolve = ApiKeyRotateMutation.resolve as Resolver
const listResolve = ApiKeysQuery.resolve as Resolver

describe("api key management metrics", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("counts a successful create", async () => {
    mockedCreate.mockResolvedValue({ keyId: "a1b2c3d4" } as CreateApiKeyResult)

    await createResolve(
      {},
      { input: { name: "x", scopes: ["read:user"] } },
      kratosContext,
    )

    expect(mockedInc).toHaveBeenCalledTimes(1)
    expect(mockedInc).toHaveBeenCalledWith("create", "success")
  })

  it("counts a failed create", async () => {
    mockedCreate.mockResolvedValue(new MaxApiKeysPerAccountError("max reached"))

    await createResolve(
      {},
      { input: { name: "x", scopes: ["read:user"] } },
      kratosContext,
    )

    expect(mockedInc).toHaveBeenCalledTimes(1)
    expect(mockedInc).toHaveBeenCalledWith("create", "failure")
  })

  it("counts the api-key-session management guard as a failure", async () => {
    await createResolve(
      {},
      { input: { name: "x", scopes: ["read:user"] } },
      apiKeyContext,
    )

    expect(mockedCreate).not.toHaveBeenCalled()
    expect(mockedInc).toHaveBeenCalledTimes(1)
    expect(mockedInc).toHaveBeenCalledWith("create", "failure")
  })

  it("counts a successful revoke", async () => {
    mockedRevoke.mockResolvedValue({ keyId: "a1b2c3d4" } as ApiKey)

    await revokeResolve({}, { input: { id: "some-id" } }, kratosContext)

    expect(mockedInc).toHaveBeenCalledTimes(1)
    expect(mockedInc).toHaveBeenCalledWith("revoke", "success")
  })

  it("counts a failed revoke", async () => {
    mockedRevoke.mockResolvedValue(new MaxApiKeysPerAccountError("nope"))

    await revokeResolve({}, { input: { id: "some-id" } }, kratosContext)

    expect(mockedInc).toHaveBeenCalledTimes(1)
    expect(mockedInc).toHaveBeenCalledWith("revoke", "failure")
  })

  it("counts a successful rotate", async () => {
    mockedRotate.mockResolvedValue({ keyId: "e5f6a7b8" } as RotatedApiKey)

    await rotateResolve({}, { input: { id: "some-id" } }, kratosContext)

    expect(mockedInc).toHaveBeenCalledTimes(1)
    expect(mockedInc).toHaveBeenCalledWith("rotate", "success")
  })

  it("counts a failed rotate", async () => {
    mockedRotate.mockResolvedValue(new MaxApiKeysPerAccountError("nope"))

    await rotateResolve({}, { input: { id: "some-id" } }, kratosContext)

    expect(mockedInc).toHaveBeenCalledTimes(1)
    expect(mockedInc).toHaveBeenCalledWith("rotate", "failure")
  })

  it("counts a successful list", async () => {
    mockedList.mockResolvedValue([])

    await listResolve({}, {}, kratosContext)

    expect(mockedInc).toHaveBeenCalledTimes(1)
    expect(mockedInc).toHaveBeenCalledWith("list", "success")
  })

  it("counts a failed list", async () => {
    mockedList.mockResolvedValue(new MaxApiKeysPerAccountError("nope"))

    await expect(listResolve({}, {}, kratosContext)).rejects.toThrow()

    expect(mockedInc).toHaveBeenCalledTimes(1)
    expect(mockedInc).toHaveBeenCalledWith("list", "failure")
  })
})
