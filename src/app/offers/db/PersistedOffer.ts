import { fromObjectId } from "@services/mongoose/utils";
import Offer from "../Offer";

class PersistedOffer extends Offer {
  readonly id: OfferId

  private constructor(record: OfferRecord) {
    const { _id, ...r } = record
    // const id = fromObjectId(r._id)
    // delete r._id
    super(r)
    this.id = fromObjectId(_id)
  }

  static from(r: OfferRecord): PersistedOffer {
    return new PersistedOffer({
      walletId: r.walletId,
      ibexTransfer: r.ibexTransfer,
      usdLiability: r.usdLiability,
      jmdLiability: r.jmdLiability,
      exchangeRate: r.exchangeRate,
      flashFee: r.flashFee,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      _id: r._id
    })
  }
}

export default PersistedOffer