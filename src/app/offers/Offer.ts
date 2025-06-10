import { CashoutDetails } from "./types"

abstract class Offer {
  readonly details: CashoutDetails

  constructor(details: CashoutDetails) {
    this.details = details
  }
}

export default Offer