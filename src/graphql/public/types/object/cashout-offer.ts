import { GT } from "@graphql/index"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import JmdAmount from "@graphql/shared/types/scalar/jmd-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

const asNumber = <T extends WalletCurrency>(f: Amount<T>) => Number(f.amount)

const CashoutOffer = GT.Object({
  name: "CashoutOffer",
  fields: () => ({
    id: {
      type: GT.NonNullID,
      description: "ID of the offer",
    },
    walletId: {
      type: GT.NonNull(WalletId),
      description: "ID for the users USD wallet to send from",
    },
    ibexTransfer: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount the user is sending to flash" ,
      resolve: (src: CashoutOffer) => asNumber(src.ibexTransfer),
    },
    usdLiability: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount Flash owes to the user denominated in USD",
      resolve: (src: CashoutOffer) => asNumber(src.usdLiability),
    },
    jmdLiability: {
      type: GT.NonNull(JmdAmount), 
      description: "The amount Flash owes to the user denominated in JMD",
      resolve: (src: CashoutOffer) => asNumber(src.jmdLiability),
    },
    exchangeRate: {
      type: GT.NonNull(GT.Float), 
      description: "The price to convert USD -> Flash",
    },
    flashFee: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount that Flash is charging for it's services",
      resolve: (src: CashoutOffer) => asNumber(src.flashFee),
    },
    expiresAt: {
      type: GT.NonNull(Timestamp), 
      description: "The time at which this offer is no longer accepted by Flash",
    },
  }),
})

export default CashoutOffer
