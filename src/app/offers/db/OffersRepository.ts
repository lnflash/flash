import { parseRepositoryError, toObjectId } from "../../../services/mongoose/utils"
import { CouldNotFindError, CouldNotFindWalletFromIdError, RepositoryError } from "@domain/errors"
import { OfferM } from "./schema"
import PersistedOffer from "./PersistedOffer"
import ValidOffer from "../ValidOffer"

class OffersRepository {
  // update or else insert
  static async upsert(o: ValidOffer): Promise<PersistedOffer | RepositoryError> {
    try {
      // const document = new OfferM({ ...o.details })
      const result= await OfferM.findOneAndReplace(
        { walletId: o.details.walletId },       // Filter to find the document
        o.details, // New document (replacing entire document)
        { upsert: true, new: true }              // Returns the replaced document
      );
      if (!result) return new CouldNotFindError("Offer with Id not found")
      return new PersistedOffer(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }
  
  static async findById(id: OfferId): Promise<PersistedOffer | RepositoryError> {
    try {
      const result: OfferRecord | null = await OfferM.findOne({ _id: toObjectId(id) })
      if (!result) return new CouldNotFindWalletFromIdError()
      else return new PersistedOffer(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }
}

export default OffersRepository