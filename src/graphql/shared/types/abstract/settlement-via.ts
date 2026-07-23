import dedent from "dedent"

import { GT } from "@graphql/index"

import { SettlementMethod } from "@domain/wallets"
import { baseLogger } from "@services/logger"

import WalletId from "@graphql/shared/types/scalar/wallet-id"

import Username from "@graphql/shared/types/scalar/username"

import LnPaymentPreImage from "@graphql/shared/types/scalar/ln-payment-preimage"

import OnChainTxHash from "../scalar/onchain-tx-hash"
import LnPaymentSecret from "../scalar/ln-payment-secret"

const SettlementViaIntraLedger = GT.Object({
  name: "SettlementViaIntraLedger",
  fields: () => ({
    counterPartyWalletId: {
      // type: GT.NonNull(WalletId),
      type: WalletId,
    },
    counterPartyUsername: {
      type: Username,
      description: dedent`Settlement destination: Could be null if the payee does not have a username`,
    },
  }),
})

const SettlementViaLn = GT.Object({
  name: "SettlementViaLn",
  fields: () => ({
    paymentSecret: {
      type: LnPaymentSecret,
      resolve: (source) => source.revealedPreImage,
      deprecationReason:
        "Shifting property to 'preImage' to improve granularity of the LnPaymentSecret type",
    },
    preImage: {
      type: LnPaymentPreImage,
      resolve: (source) => source.revealedPreImage,
    },
  }),
})

const SettlementViaOnChain = GT.Object({
  name: "SettlementViaOnChain",
  fields: () => ({
    transactionHash: { type: OnChainTxHash },
    vout: { type: GT.Int },
  }),
})

const SettlementVia = GT.Union({
  name: "SettlementVia",
  types: () => [SettlementViaIntraLedger, SettlementViaLn, SettlementViaOnChain],
  // settlementVia is NonNull on Transaction: a source that fails to resolve
  // fails the entire transaction list query for the account. Unrecognized
  // sources degrade to the all-nullable IntraLedger member instead.
  resolveType: (source) => {
    switch (source.type) {
      case SettlementMethod.IntraLedger:
        return "SettlementViaIntraLedger"
      case SettlementMethod.Lightning:
        return "SettlementViaLn"
      case SettlementMethod.OnChain:
        return "SettlementViaOnChain"
      default:
        baseLogger.error(
          { settlementViaType: source.type },
          "Unrecognized settlementVia type; defaulting to SettlementViaIntraLedger",
        )
        return "SettlementViaIntraLedger"
    }
  },
})

export default SettlementVia
