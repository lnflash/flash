import { extendSchema, parse, lexicographicSortSchema, printSchema } from "graphql"
import { addResolversToSchema } from "@graphql-tools/schema"
import { isProd, isRunningJest } from "@config"

import resolvers from "../resolvers"

import { gqlMainSchema } from "../../../graphql/main"

const extensionSDL = `
extend type Query {
    externalWalletById(accountId: ID!): ExternalWallet
    getExternalWalletDetails(accountId: ID!): ExternalWalletDetails!
}

extend type Mutation {
    getExternalWalletToken(credentials: ExternalWalletCredentials!): ExternalWalletSignInResponse!
    refreshExternalWalletToken(refreshToken: String!): ExternalWalletAuthRefreshResponse!
    createExternalWallet(credentials: CreateExternalWalletInput!): CreateExternalWalletResponse!
}

input ExternalWalletCredentials {
    email: String!
    password: String!
}

type ExternalWalletSignInResponse {
    accessToken: String!
    accessTokenExpiresAt: Int!
    refreshToken: String!
    refreshTokenExpiresAt: Int!
}
  
type ExternalWalletAuthRefreshResponse {
    accessToken: String!
    expiresAt: Int!
}

input CreateExternalWalletInput {
    currencyId: Int!
    name: String!
}

type CreateExternalWalletResponse {
    id: ID!
    userId: ID!
    organizationId: ID!
    name: String
    currencyId: Int
}

type ExternalWalletDetails {
    id: ID!
    userId: ID!
    name: String!
    currencyId: Int!
    balance: Float!
}

type ExternalWallet implements Wallet {
    accountId: ID!
    externalId: ID!
    externalUserId: ID!
    organizationId: ID!
    currencyId: Int!
    balance: SignedAmount!
    id: ID!

    """
    An unconfirmed incoming onchain balance.
    """
    pendingIncomingBalance: SignedAmount!
    transactions(
        """
        Returns the items in the list that come after the specified cursor.
        """
        after: String

        """
        Returns the items in the list that come before the specified cursor.
        """
        before: String

        """
        Returns the first n items from the list.
        """
        first: Int

        """
        Returns the last n items from the list.
        """
        last: Int
    ): TransactionConnection
    transactionsByAddress(
        """
        Returns the items that include this address.
        """
        address: OnChainAddress!

        """
        Returns the items in the list that come after the specified cursor.
        """
        after: String

        """
        Returns the items in the list that come before the specified cursor.
        """
        before: String

        """
        Returns the first n items from the list.
        """
        first: Int

        """
        Returns the last n items from the list.
        """
        last: Int
    ): TransactionConnection
    walletCurrency: WalletCurrency!
}

extend interface Account {
    externalWallets: [ExternalWallet!]!
}

extend type ConsumerAccount {
    externalWallets: [ExternalWallet!]!
  }
`

const extendedSchema = extendSchema(gqlMainSchema, parse(extensionSDL))

const schemaWithResolvers = addResolversToSchema({
  schema: extendedSchema,
  resolvers,
})

if (!isProd && !isRunningJest) {
  import("@services/fs").then(({ writeSDLFile }) => {
    writeSDLFile(
      __dirname + "/schema.graphql",
      printSchema(lexicographicSortSchema(extendedSchema)),
    )
  })
}

export default schemaWithResolvers
