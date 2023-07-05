/* eslint-disable @typescript-eslint/no-explicit-any */
interface ExternalWalletCredentials {
  email: string
  password: string
}

const AuthenticationResolvers = {
  Mutation: {
    getExternalWalletToken: async (
      _: any,
      { credentials }: { credentials: ExternalWalletCredentials },
      { dataSources }: { dataSources: any },
    ) => {
      return dataSources.authenticationAPI.getAuthToken(
        credentials.email,
        credentials.password,
      )
    },
    refreshExternalWalletToken: async (
      _: any,
      { refreshToken }: { refreshToken: string },
      { dataSources }: { dataSources: any },
    ) => {
      return dataSources.authenticationAPI.refreshAuthToken(refreshToken)
    },
  },
}

export default AuthenticationResolvers
