/* eslint-disable @typescript-eslint/no-explicit-any */
import ExternalWallet from "../models/externalWallet"

interface getExternalWalletByIdResponse {
  accountId: string
  externalId: string
  externalUserId: string
  organizationId: string
  currencyId: number
}

interface ExternalWalletDetailsResponse {
  id: string
  userId: string
  name: string
  currencyId: number
  balance: number
}
interface CreateExternalWalletInput {
  currencyId: number
  name: string
}

interface CreateExternalWalletResponse {
  id: string
  userId: string
  organizationId: string
  name: string
  currencyId: number
}

interface ExternalWalletResponse {
  accountId: string
  externalId: string
  externalUserId: string
  organizationId: string
  currencyId: number
  balance: number
  id: string
  pendingIncomingBalance: number
  transactions: any
  transactionsByAddress: any
  walletCurrency: any
}

const ExternalWalletResolvers = {
  Mutation: {
    createExternalWallet: async (
      _: any,
      { credentials }: { credentials: CreateExternalWalletInput },
      { dataSources }: { dataSources: any },
    ) => {
      const result: CreateExternalWalletResponse =
        await dataSources.externalWalletAPI.createExternalWallet(
          credentials.currencyId,
          credentials.name,
        )
      if (!result) {
        throw new Error("Failed to create external wallet")
      }
      return result
    },
  },
  Query: {
    externalWalletById: async (
      _: any,
      { accountId }: { accountId: string },
      { dataSources }: { dataSources: any },
    ) => {
      const result: getExternalWalletByIdResponse =
        await dataSources.externalWalletAPI.getExternalWalletByAccountId(accountId)
      return result
    },
    getExternalWalletDetails: async (
      _: any,
      { externalId }: { externalId: string },
      { dataSources }: { dataSources: any },
    ) => {
      const result: ExternalWalletDetailsResponse =
        await dataSources.externalWalletAPI.getExternalWalletDetails(externalId)
      return result
    },
  },
  ConsumerAccount: {
    externalWallets: async (
      source: { id: string },
      args: any,
      { dataSources }: { dataSources: any },
    ) => {
      console.log("#1 Getting external wallets for account", source.id)
      const externalWallets = await ExternalWallet.find({ accountId: source.id })
      return Promise.all(
        externalWallets.map(async (wallet) => {
          const localData: getExternalWalletByIdResponse =
            await dataSources.externalWalletAPI.getExternalWalletByAccountId(
              wallet.accountId,
            )
          const details: ExternalWalletDetailsResponse =
            await dataSources.externalWalletAPI.getExternalWalletDetails(
              wallet.externalId,
            )
          console.log(
            "#2 accountId after ConsumerAccount.externalwallets",
            wallet.accountId,
          )
          // merge local wallet data and API details
          console.log("localData before merge", localData)
          console.log("details before merge", details)
          const merged = { ...localData, ...details }
          console.log("merged data", merged)
          return merged
        }),
      )
    },
  },
  ExternalWallet: {
    accountId: (externalWallet: ExternalWalletResponse) => {
      console.log("#3 accountId in ExternalWallet", externalWallet.accountId)
      return externalWallet.accountId
    },
    externalId: (externalWallet: ExternalWalletResponse) => externalWallet.externalId,
    externalUserId: (externalWallet: ExternalWalletResponse) =>
      externalWallet.externalUserId,
    organizationId: (externalWallet: ExternalWalletResponse) =>
      externalWallet.organizationId,
    balance: (externalWallet: ExternalWalletResponse) => externalWallet.balance,
    pendingIncomingBalance: () => 0, // TODO: Populate with actual pending incoming balances from IBEX where possible
    walletCurrency: async (
      externalWallet: ExternalWalletResponse,
      _: any,
      { dataSources }: { dataSources: any },
    ) => {
      const currencyIdString = await dataSources.externalWalletAPI.getCurrencyString(
        externalWallet.currencyId,
      )
      return currencyIdString
    },
  },
}

export default ExternalWalletResolvers
