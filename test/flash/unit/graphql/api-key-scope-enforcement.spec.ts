import { GraphQLResolveInfo } from "graphql"
import { and } from "graphql-shield"
import { IOptions, IShieldContext } from "graphql-shield/typings/types"

import {
  API_KEY_SCOPES,
  InsufficientApiKeyScopeError,
  apiKeyScopeForField,
} from "@domain/api-keys"
import { mutationFields } from "@graphql/public/mutations"
import { queryFields } from "@graphql/public/queries"
import { disconnectAll } from "@services/redis"
import {
  isAuthenticated,
  scopedApiKeyAccess,
  scopedApiKeyTypeField,
} from "@servers/graphql-server"

// Importing the root-field barrels transitively creates the app-wide Redis
// clients; disconnect so jest exits without --forceExit (same pattern as
// test/flash/integration/jest.setup.ts).
afterAll(() => {
  disconnectAll()
})

const authedRootFields = [
  ...Object.keys(queryFields.authed.atAccountLevel),
  ...Object.keys(queryFields.authed.atWalletLevel),
  ...Object.keys(mutationFields.authed.atAccountLevel),
  ...Object.keys(mutationFields.authed.atWalletLevel),
]

// Minimal shield plumbing for direct rule invocation. Contextual-cache rules
// read/write ctx._shield.cache; options is only consulted for strict caching
// and debug, neither of which these rules use.
const shieldOptions = { debug: true, hashFunction: () => "" } as unknown as IOptions

const info = {} as GraphQLResolveInfo

type PartialCtx = {
  sessionId?: string
  scopes?: string[]
  domainAccount?: { id: string }
}

const makeCtx = (ctx: PartialCtx) =>
  ({ ...ctx, _shield: { cache: {} } }) as unknown as GraphQLPublicContext & IShieldContext

type ResolvableRule = {
  resolve: (
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ) => Promise<unknown>
}

const invoke = (rule: ResolvableRule, ctx: PartialCtx) =>
  rule.resolve({}, {}, makeCtx(ctx), info, shieldOptions)

const kratosCtx = { sessionId: "fa595e7b-7c7e-485c-be06-d968be32ec64" }
const apiKeyCtx = (scopes: string[]) => ({ sessionId: "apikey:8e8b4f60", scopes })

describe("apiKeyScopeForField completeness", () => {
  it("maps every authed root field (deny-by-default regression net)", () => {
    const unmapped = authedRootFields.filter(
      (field) => apiKeyScopeForField[field] === undefined,
    )
    expect(unmapped).toEqual([])
  })

  it("has no entries for fields that no longer exist in the schema", () => {
    const known = new Set(authedRootFields)
    const stale = Object.keys(apiKeyScopeForField).filter((field) => !known.has(field))
    expect(stale).toEqual([])
  })

  it("only maps to valid scopes or BLOCKED", () => {
    const valid = new Set<string>([...API_KEY_SCOPES, "BLOCKED"])
    const invalid = Object.entries(apiKeyScopeForField).filter(
      ([, access]) => !valid.has(access),
    )
    expect(invalid).toEqual([])
  })
})

describe("scopedApiKeyAccess", () => {
  it("passes kratos sessions untouched, even on BLOCKED fields", async () => {
    await expect(invoke(scopedApiKeyAccess("apiKeys"), kratosCtx)).resolves.toBe(true)
    await expect(invoke(scopedApiKeyAccess("me"), kratosCtx)).resolves.toBe(true)
  })

  it("passes anon sessions untouched (isAuthenticated still gates them)", async () => {
    await expect(invoke(scopedApiKeyAccess("me"), {})).resolves.toBe(true)
  })

  it("passes an api-key session holding the required scope", async () => {
    await expect(
      invoke(scopedApiKeyAccess("me"), apiKeyCtx(["read:user"])),
    ).resolves.toBe(true)
  })

  it("honors write-implies-read and admin grants", async () => {
    await expect(
      invoke(scopedApiKeyAccess("onChainTxFee"), apiKeyCtx(["write:wallet"])),
    ).resolves.toBe(true)
    await expect(
      invoke(scopedApiKeyAccess("intraLedgerPaymentSend"), apiKeyCtx(["admin"])),
    ).resolves.toBe(true)
  })

  it("rejects an api-key session missing the required scope", async () => {
    const res = await invoke(scopedApiKeyAccess("me"), apiKeyCtx(["read:wallet"]))
    expect(res).toBeInstanceOf(InsufficientApiKeyScopeError)
    expect((res as Error).message).toMatch(/read:user/)
  })

  it("rejects BLOCKED fields regardless of granted scopes", async () => {
    const res = await invoke(scopedApiKeyAccess("apiKeys"), apiKeyCtx(["admin"]))
    expect(res).toBeInstanceOf(InsufficientApiKeyScopeError)
    expect((res as Error).message).toMatch(/cannot access apiKeys/)
  })

  it("rejects unmapped fields (deny-by-default)", async () => {
    const res = await invoke(scopedApiKeyAccess("someFutureField"), apiKeyCtx(["admin"]))
    expect(res).toBeInstanceOf(InsufficientApiKeyScopeError)
    expect((res as Error).message).toMatch(/cannot access someFutureField/)
  })

  it("treats an api-key session with no scope claim as having no scopes", async () => {
    const res = await invoke(scopedApiKeyAccess("me"), {
      sessionId: "apikey:8e8b4f60",
    })
    expect(res).toBeInstanceOf(InsufficientApiKeyScopeError)
  })
})

describe("and(isAuthenticated, scopedApiKeyAccess) composition", () => {
  const account = { id: "account-id" }

  it("surfaces the scope error for an authed api-key session", async () => {
    const composed = and(isAuthenticated, scopedApiKeyAccess("apiKeys"))
    const res = await invoke(composed, {
      ...apiKeyCtx(["admin"]),
      domainAccount: account,
    })
    expect(res).toBeInstanceOf(InsufficientApiKeyScopeError)
  })

  it("still denies unauthenticated sessions via the auth rule", async () => {
    const composed = and(isAuthenticated, scopedApiKeyAccess("me"))
    await expect(invoke(composed, {})).resolves.toBe(false)
  })

  it("passes an authed api-key session with the right scope", async () => {
    const composed = and(isAuthenticated, scopedApiKeyAccess("me"))
    await expect(
      invoke(composed, { ...apiKeyCtx(["read:user"]), domainAccount: account }),
    ).resolves.toBe(true)
  })

  it("passes an authed kratos session", async () => {
    const composed = and(isAuthenticated, scopedApiKeyAccess("apiKeys"))
    await expect(
      invoke(composed, { ...kratosCtx, domainAccount: account }),
    ).resolves.toBe(true)
  })
})

describe("scopedApiKeyTypeField (nested wallet/transaction guard)", () => {
  it("passes non-api-key sessions untouched", async () => {
    await expect(invoke(scopedApiKeyTypeField("read:wallet"), kratosCtx)).resolves.toBe(
      true,
    )
  })

  it("passes an api-key session holding the required scope", async () => {
    await expect(
      invoke(scopedApiKeyTypeField("read:wallet"), apiKeyCtx(["read:wallet"])),
    ).resolves.toBe(true)
    await expect(
      invoke(scopedApiKeyTypeField("read:transactions"), apiKeyCtx(["admin"])),
    ).resolves.toBe(true)
  })

  it("rejects an api-key session missing the required scope", async () => {
    const res = await invoke(
      scopedApiKeyTypeField("read:wallet"),
      apiKeyCtx(["read:user"]),
    )
    expect(res).toBeInstanceOf(InsufficientApiKeyScopeError)
    expect((res as Error).message).toMatch(/read:wallet/)
  })
})
