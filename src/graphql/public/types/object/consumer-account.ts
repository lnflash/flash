import { Accounts, Prices } from "@app"
import {
  cashWalletHistoryWalletIdsForPresentation,
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

import Wallet from "@graphql/shared/types/abstract/wallet"
import IAccount from "@graphql/public/types/abstract/account"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import RealtimePrice from "@graphql/public/types/object/realtime-price"
import DisplayCurrency from "@graphql/shared/types/scalar/display-currency"

import { listEndpoints } from "@app/callback"

import AccountLevel from "../../../shared/types/scalar/account-level"
import AccountCapabilities from "../../../shared/types/object/account-capabilities"
import AccountStatusHeadline from "../../../shared/types/scalar/account-status-headline"

import { TransactionConnection } from "../../../shared/types/object/transaction"

import AccountLimits from "./account-limits"
import Quiz from "./quiz"
import CallbackEndpoint from "./callback-endpoint"
import { NotificationSettings } from "./notification-settings"

const ConsumerAccount = GT.Object<Account, GraphQLPublicContextAuth>({
  name: "ConsumerAccount",
  interfaces: () => [IAccount],
  isTypeOf: () => true, // TODO: improve

  fields: () => ({
    id: {
      type: GT.NonNullID,
      resolve: (source) => source.uuid,
    },

    callbackEndpoints: {
      type: GT.NonNullList(CallbackEndpoint),
      resolve: async (source, args, { domainAccount }) => {
        return listEndpoints(domainAccount.uuid)
      },
    },

    wallets: {
      type: GT.NonNullList(Wallet),
      resolve: async (source, args, { cashWalletClientCapabilities }) => {
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
      resolve: async (source, args, { cashWalletClientCapabilities }) => {
        const presentation = await resolveCashWalletPresentationForAccount({
          account: source,
          client: cashWalletClientCapabilities,
        })
        if (presentation instanceof Error) throw mapError(presentation)

        return presentation.defaultWalletId
      },
    },

    displayCurrency: {
      type: GT.NonNull(DisplayCurrency),
      resolve: (source) => source.displayCurrency,
    },

    level: {
      type: GT.NonNull(AccountLevel),
      description:
        "Internal account level, derived from capabilities (ENG-516). Present capabilities and statusHeadline instead of this.",
      resolve: (source) => source.level,
    },

    capabilities: {
      type: GT.NonNull(AccountCapabilities),
      resolve: async (source) => {
        const result = await Accounts.getAccountCapabilities(source)
        return result.capabilities
      },
    },

    statusHeadline: {
      type: GT.NonNull(AccountStatusHeadline),
      resolve: async (source) => {
        const result = await Accounts.getAccountCapabilities(source)
        return result.statusHeadline
      },
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

    limits: {
      type: GT.NonNull(AccountLimits),
      resolve: (source) => source,
    },

    quiz: {
      type: GT.NonNullList(Quiz),
      description: "List the quiz questions of the consumer account",
      resolve: (source) => source.quiz,
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
      resolve: async (source, args, { cashWalletClientCapabilities }) => {
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

        walletIds = cashWalletHistoryWalletIdsForPresentation({
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

export default ConsumerAccount
