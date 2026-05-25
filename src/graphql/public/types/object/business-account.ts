import { Accounts, Prices } from "@app"
import {
  cashWalletTransactionWalletIdsForPresentation,
  resolveCashWalletPresentationForAccount,
} from "@app/cash-wallet-cutover"

import {
  majorToMinorUnit,
  SAT_PRICE_PRECISION_OFFSET,
  USD_PRICE_PRECISION_OFFSET,
} from "@domain/fiat"
import { CouldNotFindTransactionsForAccountError } from "@domain/errors"

import { GT } from "@graphql/index"
import { mapError } from "@graphql/error-map"
import {
  connectionArgs,
  connectionFromPaginatedArray,
  checkedConnectionArgs,
} from "@graphql/connections"

import IAccount from "../abstract/account"
import Wallet from "../../../shared/types/abstract/wallet"

import WalletId from "../../../shared/types/scalar/wallet-id"
import DisplayCurrency from "../../../shared/types/scalar/display-currency"

import AccountLevel from "../../../shared/types/scalar/account-level"

import { TransactionConnection } from "../../../shared/types/object/transaction"

import RealtimePrice from "./realtime-price"
import { NotificationSettings } from "./notification-settings"

const BusinessAccount = GT.Object<Account, GraphQLPublicContextAuth>({
  name: "BusinessAccount",
  interfaces: () => [IAccount],
  isTypeOf: () => false,
  fields: () => ({
    id: {
      type: GT.NonNullID,
      resolve: (source) => source.uuid,
    },

    wallets: {
      type: GT.NonNullList(Wallet),
      resolve: async (
        source: Account,
        args,
        { cashWalletClientCapabilities }: GraphQLPublicContextAuth,
      ) => {
        const presentation = await resolveCashWalletPresentationForAccount({
          account: source,
          client: cashWalletClientCapabilities,
        })
        if (presentation instanceof Error) throw mapError(presentation)

        return presentation.wallets
      },
    },

    defaultWalletId: {
      type: GT.NonNull(WalletId),
      resolve: async (
        source: Account,
        args,
        { cashWalletClientCapabilities }: GraphQLPublicContextAuth,
      ) => {
        const presentation = await resolveCashWalletPresentationForAccount({
          account: source,
          client: cashWalletClientCapabilities,
        })
        if (presentation instanceof Error) throw mapError(presentation)

        return presentation.defaultWalletId
      },
    },

    level: {
      type: GT.NonNull(AccountLevel),
      resolve: (source) => source.level,
    },

    displayCurrency: {
      type: GT.NonNull(DisplayCurrency),
      resolve: (source, args, { domainAccount }) => domainAccount.displayCurrency,
    },

    realtimePrice: {
      type: GT.NonNull(RealtimePrice),
      resolve: async (source) => {
        const currency = source.displayCurrency
        const btcPrice = await Prices.getCurrentSatPrice({ currency })
        if (btcPrice instanceof Error) throw mapError(btcPrice)

        const usdPrice = await Prices.getCurrentUsdCentPrice({ currency })
        if (usdPrice instanceof Error) throw mapError(usdPrice)

        const minorUnitPerSat = majorToMinorUnit({
          amount: btcPrice.price,
          displayCurrency: currency,
        })
        const minorUnitPerUsdCent = majorToMinorUnit({
          amount: usdPrice.price,
          displayCurrency: currency,
        })

        return {
          timestamp: btcPrice.timestamp,
          denominatorCurrency: currency,
          btcSatPrice: {
            base: Math.round(minorUnitPerSat * 10 ** SAT_PRICE_PRECISION_OFFSET),
            offset: SAT_PRICE_PRECISION_OFFSET,
            currencyUnit: "MINOR",
          },
          usdCentPrice: {
            base: Math.round(minorUnitPerUsdCent * 10 ** USD_PRICE_PRECISION_OFFSET),
            offset: USD_PRICE_PRECISION_OFFSET,
            currencyUnit: "MINOR",
          },
        }
      },
    },

    csvTransactions: {
      description:
        "return CSV stream, base64 encoded, of the list of transactions in the wallet",
      type: GT.NonNull(GT.String),
      args: {
        walletIds: {
          type: GT.NonNullList(WalletId),
        },
      },
      resolve: async (source) => {
        return Accounts.getCSVForAccount(source.id)
      },
    },
    transactions: {
      description:
        "A list of all transactions associated with walletIds optionally passed.",
      type: TransactionConnection,
      args: {
        ...connectionArgs,
        walletIds: {
          type: GT.List(WalletId),
        },
      },
      resolve: async (
        source: Account,
        args,
        { cashWalletClientCapabilities }: GraphQLPublicContextAuth,
      ) => {
        const paginationArgs = checkedConnectionArgs(args)
        if (paginationArgs instanceof Error) {
          throw paginationArgs
        }

        const presentation = await resolveCashWalletPresentationForAccount({
          account: source,
          client: cashWalletClientCapabilities,
        })
        if (presentation instanceof Error) throw mapError(presentation)

        let { walletIds } = args

        walletIds = cashWalletTransactionWalletIdsForPresentation({
          walletIds,
          presentation,
        })

        const { result, error } = await Accounts.getTransactionsForAccountByWalletIds({
          account: source,
          walletIds,
          paginationArgs,
        })
        if (error instanceof Error) {
          throw mapError(error)
        }

        if (!result?.slice) {
          const nullError = new CouldNotFindTransactionsForAccountError()
          throw mapError(nullError)
        }

        return connectionFromPaginatedArray<BaseWalletTransaction>(
          result.slice,
          result.total,
          paginationArgs,
        )
      },
    },
    notificationSettings: {
      type: GT.NonNull(NotificationSettings),
      resolve: (source) => source.notificationSettings,
    },
  }),
})

export default BusinessAccount
