// Source-derived, idempotent SDL update without starting servers or providers.
// Run under Node24 with ts-node/register/transpile-only + tsconfig-paths/register.
const fs = require("node:fs")
const path = require("node:path")
const {
  GraphQLSchema,
  GraphQLObjectType,
  Kind,
  buildASTSchema,
  extendSchema,
  lexicographicSortSchema,
  parse,
  printSchema,
} = require("graphql")
const {
  ownedWalletSnapshotField,
} = require("../src/graphql/public/types/object/owned-wallet-snapshot")
const target = path.resolve(__dirname, "../src/graphql/public/schema.graphql")
const names = new Set(["OwnedWalletSnapshot", "OwnedWalletMetadata"])
const original = parse(fs.readFileSync(target, "utf8"))
const baseDocument = {
  ...original,
  definitions: original.definitions
    .filter((node) => !names.has(node.name?.value))
    .map((node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION && node.name.value === "ConsumerAccount"
        ? {
            ...node,
            fields: node.fields.filter(
              (field) => field.name.value !== "ownedWalletSnapshot",
            ),
          }
        : node,
    ),
}
const mini = parse(
  printSchema(
    new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "SnapshotQuery",
        fields: { ownedWalletSnapshot: ownedWalletSnapshotField },
      }),
    }),
  ),
)
const field = mini.definitions.find((node) => node.name?.value === "SnapshotQuery")
  .fields[0]
const extension = {
  kind: Kind.DOCUMENT,
  definitions: [
    ...mini.definitions.filter((node) => names.has(node.name?.value)),
    {
      kind: Kind.OBJECT_TYPE_EXTENSION,
      name: { kind: Kind.NAME, value: "ConsumerAccount" },
      interfaces: [],
      directives: [],
      fields: [field],
    },
  ],
}
const schema = extendSchema(buildASTSchema(baseDocument), extension)
fs.writeFileSync(target, printSchema(lexicographicSortSchema(schema)))
