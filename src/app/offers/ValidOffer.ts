import { intraledgerPaymentSendWalletIdForUsdWallet } from "../payments/send-intraledger"
import { LedgerService } from "@services/ledger"
import { getBankOwnerWalletId } from "@services/ledger/caching"
import Offer from "./Offer"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import PersistedOffer from "./db/PersistedOffer"
import OffersRepository from "./db/OffersRepository"

class ValidOffer extends Offer {
  
  constructor(o: Offer) {
    super(o.details)
  }

  async persist(): Promise<PersistedOffer | RepositoryError> {
    return OffersRepository.upsert(this)
  }

  async execute(): Promise<PaymentSendStatus | Error> {
    const { walletId, ibexTransfer } = this.details
    const flashWalletId = await getBankOwnerWalletId()

    const ibexResp = await intraledgerPaymentSendWalletIdForUsdWallet({
      senderWalletId: walletId, 
      recipientWalletId: flashWalletId,
      amount: Number(ibexTransfer),
      memo: "Cash Out",
    }) 
    if (ibexResp instanceof Error) return ibexResp 

    const res = await LedgerService().recordCashOut(this)

    return PaymentSendStatus.Pending // awaiting rtgs transfer
  }
}

export default ValidOffer