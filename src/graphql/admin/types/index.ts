import BtcWallet from "@graphql/types/object/btc-wallet"
import GraphQLApplicationError from "@graphql/types/object/graphql-application-error"
import UsdWallet from "@graphql/types/object/usd-wallet"

import IbexWallet from "../../../services/ibex-plugin/types/object/ibex-wallet"

export const ALL_INTERFACE_TYPES = [
  GraphQLApplicationError,
  BtcWallet,
  UsdWallet,
  IbexWallet,
]
