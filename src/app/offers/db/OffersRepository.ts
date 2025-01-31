import Offer, { CashoutDetails } from "@app/offers/Offer"
import { parseRepositoryError } from "../../../services/mongoose/utils"
import { CouldNotFindWalletFromIdError } from "@domain/errors"
import { OfferM, OfferRecord } from "./schema"
import PersistedOffer from "./PersistedOffer"

class OffersRepository {
  // update or else insert
  static async upsert(o: Offer): Promise<PersistedOffer | RepositoryError> {
    try {
      const document = new OfferM({ ...o.details })
      return new PersistedOffer(await document.save())
    } catch (err) {
      return parseRepositoryError(err)
    }
  }
  
  static async findById(id: OfferId): Promise<PersistedOffer | RepositoryError> {
    try {
      const result: OfferRecord | null = await OfferM.findOne({ id })
      if (!result) return new CouldNotFindWalletFromIdError()
      else return new PersistedOffer(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }
}

export default OffersRepository