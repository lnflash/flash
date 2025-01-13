import Offer from "../Offer";

class PersistedOffer extends Offer {
  readonly id: OfferId

  constructor(id: OfferId, offer: CashoutDetails) {
    super(offer)
    this.id = id
  }
}

export default PersistedOffer