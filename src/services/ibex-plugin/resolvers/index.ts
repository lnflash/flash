import ExternalWalletResolvers from "./externalWalletResolver"
import AuthenticationResolvers from "./authenticationResolver"

const resolvers = {
  Query: {
    ...ExternalWalletResolvers.Query,
    // Add other Query resolvers here...
  },
  Mutation: {
    ...ExternalWalletResolvers.Mutation,
    ...AuthenticationResolvers.Mutation,
    // Add other Mutation resolvers here...
  },
  ConsumerAccount: {
    ...ExternalWalletResolvers.ConsumerAccount,
  },
  ExternalWallet: {
    ...ExternalWalletResolvers.ExternalWallet,
  },
  // Add other types here...
}

export default resolvers
