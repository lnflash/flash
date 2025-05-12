import BtcWallet from "@graphql/shared/types/object/btc-wallet"
import GraphQLApplicationError from "@graphql/shared/types/object/graphql-application-error"
import UsdWallet from "@graphql/shared/types/object/usd-wallet"
import AuthToken from "@graphql/shared/types/scalar/auth-token"

export const ALL_INTERFACE_TYPES = [GraphQLApplicationError, BtcWallet, UsdWallet, AuthToken]
