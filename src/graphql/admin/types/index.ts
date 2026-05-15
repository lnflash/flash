import BtcWallet from "@graphql/shared/types/object/btc-wallet"
import GraphQLApplicationError from "@graphql/shared/types/object/graphql-application-error"
import UsdWallet from "@graphql/shared/types/object/usd-wallet"
import UsdtWallet from "@graphql/shared/types/object/usdt-wallet"

export const ALL_INTERFACE_TYPES = [GraphQLApplicationError, BtcWallet, UsdWallet, UsdtWallet]
