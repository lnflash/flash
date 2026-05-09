import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import Timestamp from "@graphql/shared/types/scalar/timestamp"
import PersistedOffer from "@app/offers/storage/PersistedOffer"
import { GraphQLObjectType } from "graphql"
import USDCentsScalar from "@graphql/shared/types/scalar/usd-cents"
import JMDCentsScalar from "@graphql/shared/types/scalar/jmd-cent-amount"
import { JMDAmount, USDAmount } from "@domain/shared"

const CashoutOffer: GraphQLObjectType<PersistedOffer, GraphQLPublicContext> = GT.Object({
  name: "CashoutOffer",
  fields: () => ({
    offerId: {
      type: GT.NonNullID,
      description: "ID of the offer",
      resolve: (o) => o.id,
    },
    walletId: {
      type: GT.NonNull(WalletId),
      description: "ID for the users USD wallet to send from",
      resolve: (o) => o.details.payment.userAcct,
    },
    send: {
      type: GT.NonNull(USDCentsScalar),
      description: "The amount the user is sending to flash",
      resolve: (o) => o.details.payment.amount,
    },
    receiveUsd: {
      type: USDCentsScalar,
      description: "The amount Flash owes to the user denominated in USD cents (null for JMD payouts)",
      resolve: (o) => o.details.payout.amount instanceof USDAmount ? o.details.payout.amount : null,
    },
    receiveJmd: {
      type: JMDCentsScalar,
      description: "The amount Flash owes to the user denominated in JMD cents (null for USD payouts)",
      resolve: (o) => o.details.payout.amount instanceof JMDAmount ? o.details.payout.amount : null,
    },
    exchangeRate: {
      type: JMDCentsScalar,
      description: "The rate used when withdrawing to a JMD bank account",
      resolve: (o) => o.details.payout.exchangeRate ?? null,
    },
    flashFee: {
      type: GT.NonNull(USDCentsScalar),
      description: "The amount that Flash is charging for its services",
      resolve: (o) => o.details.payout.serviceFee,
    },
    expiresAt: {
      type: GT.NonNull(Timestamp),
      description: "The time at which this offer is no longer accepted by Flash",
      resolve: (o) => o.details.payment.invoice.expiresAt.getTime(),
    },
  }),
})

export default CashoutOffer
