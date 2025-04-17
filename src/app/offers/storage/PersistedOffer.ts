import Offer from "../Offer";
import { CashoutDetails } from "../types";

class PersistedOffer extends Offer {
  readonly id: OfferId

  constructor(id: OfferId, offer: CashoutDetails) {
    super(offer)
    this.id = id
  }
}

export default PersistedOffer