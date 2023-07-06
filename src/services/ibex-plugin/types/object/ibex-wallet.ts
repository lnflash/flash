/* eslint-disable @typescript-eslint/no-explicit-any */
import { GT } from "@graphql/index"
// import {
//   connectionArgs,
//   connectionFromPaginatedArray,
//   checkedConnectionArgs,
// } from "@graphql/connections"
import { mapError } from "@graphql/error-map"

// import { Wallets } from "@app"

import { WalletCurrency as WalletCurrencyDomain } from "@domain/shared"
// import { MismatchedCurrencyForWalletError } from "@domain/errors"

import IWallet from "../../../../graphql/types/abstract/wallet"

import WalletCurrency from "../../../../graphql/types/scalar/wallet-currency"
import SignedAmount from "../../../../graphql/types/scalar/signed-amount"
// import OnChainAddress from "../../../../graphql/types/scalar/on-chain-address"

// import { TransactionConnection } from "../../../../graphql/types/object/transaction"

const IbexWallet = GT.Object<Wallet>({
  name: "IbexWallet",
  description:
    "A wallet belonging to an account which contains a USD balance and a list of transactions.",
  interfaces: () => [IWallet],
  isTypeOf: (source) => source.currency === WalletCurrencyDomain.Usd,
  fields: () => ({
    id: {
      type: GT.NonNullID,
    },
    accountId: {
      type: GT.NonNullID,
    },
    walletCurrency: {
      type: GT.NonNull(WalletCurrency),
      resolve: (source) => source.currency,
    },
    balance: {
      type: GT.NonNull(SignedAmount),
      resolve:
        () =>
        async (
          source: any,
          _: any,
          { dataSources }: { dataSources: any },
        ): Promise<number> => {
          try {
            const response = await dataSources.externalWalletAPI.getExternalWalletDetails(
              source.id,
            )
            if (response instanceof Error) {
              throw mapError(response)
            }
            return response.balance
          } catch (error) {
            console.error(error)
            throw new Error("Failed to fetch wallet balance")
          }
        },
    },
  }),
})

export default IbexWallet
