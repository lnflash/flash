import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import Timestamp from "@graphql/shared/types/scalar/timestamp"
import { CashoutOffer } from "@app/offers"
import PersistedOffer from "@app/offers/storage/PersistedOffer"
import { GraphQLObjectType } from "graphql"
import USDCentsScalar from "@graphql/shared/types/scalar/usd-cents"
import JMDCentsScalar from "@graphql/shared/types/scalar/jmd-cent-amount"

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
      resolve: (o) => o.details.ibexTrx.userAcct,
    },
    send: {
      type: GT.NonNull(USDCentsScalar), 
      description: "The amount the user is sending to flash" ,
      resolve: (o) => o.details.ibexTrx.usd // Number(src.details.ibexTrx.usd.asCents(2)),
    },
    receiveUsd: {
      type: GT.NonNull(USDCentsScalar), 
      description: "The amount Flash owes to the user denominated in USD as cents",
      resolve: (o) => o.details.flash.liability.usd // Number(src.details.flash.liability.usd.asCents(0)),
    },
    receiveJmd: {
      type: GT.NonNull(JMDCentsScalar), 
      description: "The amount Flash owes to the user denominated in JMD as cents",
      resolve: (o) => o.details.flash.liability.jmd,
    },
    // exchangeRate: {
    //   type: GT.NonNull(GT.Float), 
    //   description: "The price to convert USD -> Flash",
    //   resolve: (src: CashoutOffer) => src.receiveJmd.exchangeRate,
    // },
    flashFee: {
      type: GT.NonNull(USDCentsScalar), 
      description: "The amount that Flash is charging for it's services",
      resolve: (o) => o.details.flash.fee // Number(src.details.flash.fee.asCents(2)),
    },
    expiresAt: {
      type: GT.NonNull(Timestamp), 
      description: "The time at which this offer is no longer accepted by Flash",
      resolve: (o) => o.details.ibexTrx.invoice.expiresAt.getTime(),
    },
  }),
})

export default CashoutOffer
