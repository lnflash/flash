import { GT } from "@graphql/index"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import JmdAmount from "@graphql/shared/types/scalar/jmd-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"
import { toNumber } from "@domain/shared"


const CashoutOffer = GT.Object({
  name: "CashoutOffer",
  fields: () => ({
    offerId: {
      type: GT.NonNullID,
      description: "ID of the offer",
    },
    walletId: {
      type: GT.NonNull(WalletId),
      description: "ID for the users USD wallet to send from",
    },
    send: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount the user is sending to flash" ,
      resolve: (src: CashoutOffer) => toNumber(src.send),
    },
    receiveUsd: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount Flash owes to the user denominated in USD",
      resolve: (src: CashoutOffer) => toNumber(src.receiveUsd),
    },
    receiveJmd: {
      type: GT.NonNull(JmdAmount), 
      description: "The amount Flash owes to the user denominated in JMD",
      resolve: (src: CashoutOffer) => toNumber(src.receiveJmd),
    },
    exchangeRate: {
      type: GT.NonNull(GT.Float), 
      description: "The price to convert USD -> Flash",
      resolve: (src: CashoutOffer) => toNumber(src.receiveJmd.exchangeRate),
    },
    flashFee: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount that Flash is charging for it's services",
      resolve: (src: CashoutOffer) => toNumber(src.flashFee),
    },
    expiresAt: {
      type: GT.NonNull(Timestamp), 
      description: "The time at which this offer is no longer accepted by Flash",
      resolve: (src: CashoutOffer) => src.expiresAt.getTime(),
    },
  }),
})

export default CashoutOffer
