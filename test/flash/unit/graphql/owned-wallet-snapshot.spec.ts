jest.mock("@config", () => ({ getOnChainWalletConfig: () => ({}) }))
jest.mock("@services/logger", () => ({
  baseLogger: { warn: jest.fn(), error: jest.fn() },
}))
const mockRead = jest.fn()
jest.mock("@app/accounts/owned-wallet-snapshot", () => ({
  getOwnedWalletSnapshot: (...args: unknown[]) => mockRead(...args),
}))

import fs from "fs"
import path from "path"

import {
  GraphQLObjectType,
  GraphQLSchema,
  buildSchema,
  getNamedType,
  graphql,
  lexicographicSortSchema,
  printSchema,
  printType,
} from "graphql"
import { GT } from "@graphql/index"
import { ownedWalletSnapshotField } from "@graphql/public/types/object/owned-wallet-snapshot"
import { apiKeyNestedFieldScopes, hasApiKeyScope } from "@domain/api-keys"

const SOURCE = {
  id: "507f1f77bcf86cd799439011",
  uuid: "01909e14-2f56-41f2-afed-21c6f714c805",
  kratosUserId: "2d63fe66-f51d-4d3a-a75b-45087857305b",
}
beforeEach(() => {
  jest.clearAllMocks()
})

it("exposes a no-argument nullable field with only descriptive metadata and explicit namespaces", () => {
  expect(ownedWalletSnapshotField.args).toBeUndefined()
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: { snapshot: ownedWalletSnapshotField },
    }),
  })
  const printed = printSchema(schema)
  expect(printed).toContain("publicAccountId: ID!")
  expect(printed).toContain("walletAccountId: ID!")
  expect(printed).toContain("defaultWalletId: WalletId\n")
  expect(printed).toContain("wallets: [OwnedWalletMetadata!]!")
  expect(printed).not.toMatch(/\bbalance\s*:|lnurl\s*:|token\s*:/)
})

it("passes authenticated source/context identity to the owner-scoped raw reader without client arguments", async () => {
  const result = {
    publicAccountId: SOURCE.uuid,
    walletAccountId: SOURCE.id,
    defaultWalletId: null,
    wallets: [],
  }
  mockRead.mockResolvedValue(result)
  const context = { domainAccount: SOURCE, user: { id: SOURCE.kratosUserId } }
  const schema = new GraphQLSchema({
    query: GT.Object({
      name: "Query",
      fields: {
        snapshot: {
          ...ownedWalletSnapshotField,
          resolve: (_source, args, ctx, info) =>
            ownedWalletSnapshotField.resolve!(SOURCE as Account, args, ctx, info),
        },
      },
    }),
  })
  const response = await graphql({
    schema,
    source:
      "{ snapshot { publicAccountId walletAccountId defaultWalletId wallets { id accountId walletCurrency isExternal } } }",
    contextValue: context,
  })
  expect(response.errors).toBeUndefined()
  expect(response.data?.snapshot).toEqual(result)
  expect(mockRead).toHaveBeenCalledWith({
    source: SOURCE,
    account: SOURCE,
    userId: SOURCE.kratosUserId,
  })
})

it("requires read:wallet for API keys at the snapshot entry and nested wallet rows", () => {
  expect(apiKeyNestedFieldScopes.ConsumerAccount.ownedWalletSnapshot).toBe("read:wallet")
  expect(apiKeyNestedFieldScopes.OwnedWalletSnapshot.wallets).toBe("read:wallet")
  expect(hasApiKeyScope({ grantedScopes: ["read:user"], required: "read:wallet" })).toBe(
    false,
  )
  expect(
    hasApiKeyScope({ grantedScopes: ["read:wallet"], required: "read:wallet" }),
  ).toBe(true)
})

it("checks the canonical SDL and composed supergraph against actual source types and field contract", () => {
  const root = path.resolve(__dirname, "../../../../")
  const canonical = buildSchema(
    fs.readFileSync(path.join(root, "src/graphql/public/schema.graphql"), "utf8"),
  )
  const sourceSchema = lexicographicSortSchema(
    new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: { snapshot: ownedWalletSnapshotField },
      }),
    }),
  )
  const snapshot = sourceSchema.getType("OwnedWalletSnapshot")!
  expect(printType(canonical.getType("OwnedWalletSnapshot")!)).toBe(printType(snapshot))
  const metadata = getNamedType((snapshot as GraphQLObjectType).getFields().wallets.type)
  expect(printType(canonical.getType("OwnedWalletMetadata")!)).toBe(printType(metadata))
  const field = (canonical.getType("ConsumerAccount") as GraphQLObjectType).getFields()
    .ownedWalletSnapshot
  expect(String(field.type)).toBe("OwnedWalletSnapshot")
  expect(field.args).toEqual([])
  const supergraph = buildSchema(
    fs.readFileSync(path.join(root, "dev/apollo-federation/supergraph.graphql"), "utf8"),
  )
  const federated = (
    supergraph.getType("ConsumerAccount") as GraphQLObjectType
  ).getFields().ownedWalletSnapshot
  expect(String(federated.type)).toBe("OwnedWalletSnapshot")
  expect(federated.args).toEqual([])
  expect(printType(supergraph.getType("OwnedWalletMetadata")!)).toContain(
    "accountId: ID!",
  )
})
