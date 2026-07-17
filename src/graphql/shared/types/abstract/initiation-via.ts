import { GT } from "@graphql/index"

import { PaymentInitiationMethod } from "@domain/wallets"
import { baseLogger } from "@services/logger"

import WalletId from "../scalar/wallet-id"
import Username from "../scalar/username"
import OnChainAddress from "../scalar/on-chain-address"
import PaymentHash from "../scalar/payment-hash"

const InitiationViaIntraLedger = GT.Object({
  name: "InitiationViaIntraLedger",
  fields: () => ({
    counterPartyWalletId: {
      // type: GT.NonNull(WalletId),
      type: WalletId,
    },
    counterPartyUsername: {
      type: Username,
    },
  }),
})

const InitiationViaLn = GT.Object({
  name: "InitiationViaLn",
  fields: () => ({
    paymentHash: {
      type: GT.NonNull(PaymentHash),
    },
  }),
})

const InitiationViaOnChain = GT.Object({
  name: "InitiationViaOnChain",
  fields: () => ({
    address: {
      type: GT.NonNull(OnChainAddress),
    },
  }),
})

const InitiationVia = GT.Union({
  name: "InitiationVia",
  types: () => [InitiationViaIntraLedger, InitiationViaLn, InitiationViaOnChain],
  // initiationVia is NonNull on Transaction: a source that fails to resolve
  // fails the entire transaction list query for the account. Unrecognized
  // sources degrade to the all-nullable IntraLedger member instead.
  resolveType: (source) => {
    switch (source.type) {
      case PaymentInitiationMethod.IntraLedger:
        return "InitiationViaIntraLedger"
      case PaymentInitiationMethod.Lightning:
        return "InitiationViaLn"
      case PaymentInitiationMethod.OnChain:
        return "InitiationViaOnChain"
      default:
        baseLogger.error(
          { initiationViaType: source.type },
          "Unrecognized initiationVia type; defaulting to InitiationViaIntraLedger",
        )
        return "InitiationViaIntraLedger"
    }
  },
})

export default InitiationVia
