import { fromObjectId } from "@services/mongoose/utils";
import Offer from "../Offer";
import { OfferRecord } from "./schema";

class PersistedOffer extends Offer {
  readonly id: OfferId

  constructor(r: OfferRecord) {
    super(r)
    this.id = fromObjectId(r._id)
  }

  // toUser(): CashoutOfferResponse {
  //   return {
  //     id: ,
  //     flashSend: this.ibexTransfer,
  //     rtgsReceiveUSD: this.usdLiability, 
  //     rtgsReceiveJMD: this.jmdLiability, 
  //     flashFee: this.flashFee,
  //     exchangeRate: this.exchangeRate,
  //     expiresAt: this.expiresAt 
  //   }
  // } 
}

export default PersistedOffer