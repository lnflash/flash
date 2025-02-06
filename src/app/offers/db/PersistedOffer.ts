import { fromObjectId } from "@services/mongoose/utils";
import Offer from "../Offer";
import { OfferM } from "./schema";
import { baseLogger } from "@services/logger";

function offerKeys() {
  return Object.keys({} as CashoutDetails) as (keyof CashoutDetails)[];
}
class PersistedOffer extends Offer {
  readonly id: OfferId

  constructor(r: OfferRecord) {
    // const schema = Object.keys(OfferM.schema.paths);
    // const r2 = Object.fromEntries(
    //   Object.entries(r).filter(([key]) => offerKeys().includes(key as keyof CashoutDetails))
    // );
    
    super(r as CashoutDetails)
    this.id = fromObjectId(r._id)
  }
}

export default PersistedOffer