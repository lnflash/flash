import { GT } from "@graphql/index"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import JmdAmount from "@graphql/shared/types/scalar/jmd-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"
import { CashoutOffer } from "@app/offers"
import PersistedOffer from "@app/offers/storage/PersistedOffer"
import { GraphQLObjectType } from "graphql"


const CashoutOffer: GraphQLObjectType<PersistedOffer, GraphQLPublicContext> = GT.Object({
  name: "CashoutOffer",
  fields: () => ({
    offerId: {
      type: GT.NonNullID,
      description: "ID of the offer",
      resolve: (src) => src.id,
    },
    walletId: {
      type: GT.NonNull(WalletId),
      description: "ID for the users USD wallet to send from",
      resolve: (src) => src.details.ibexTrx.userAcct,
    },
    send: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount the user is sending to flash" ,
      resolve: (src) => Number(src.details.ibexTrx.usd.asCents(2)),
    },
    receiveUsd: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount Flash owes to the user denominated in USD as cents",
      resolve: (src) => Number(src.details.flash.liability.usd.asCents(0)),
    },
    receiveJmd: {
      type: GT.NonNull(JmdAmount), 
      description: "The amount Flash owes to the user denominated in JMD as cents",
      resolve: (src) => Number(src.details.flash.liability.jmd.asCents(0)),
    },
    // exchangeRate: {
    //   type: GT.NonNull(GT.Float), 
    //   description: "The price to convert USD -> Flash",
    //   resolve: (src: CashoutOffer) => src.receiveJmd.exchangeRate,
    // },
    flashFee: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount that Flash is charging for it's services",
      resolve: (src) => Number(src.details.flash.fee.asCents(2)),
    },
    expiresAt: {
      type: GT.NonNull(Timestamp), 
      description: "The time at which this offer is no longer accepted by Flash",
      resolve: (src) => src.details.ibexTrx.invoice.expiresAt.getTime(),
    },
  }),
})

export default CashoutOffer
