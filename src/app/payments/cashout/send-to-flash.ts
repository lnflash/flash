import { intraledgerPaymentSendWalletIdForUsdWallet } from "../send-intraledger"
import { LedgerService } from "@services/ledger"

export const cashout = async (sender: WalletId, amount: Amount<"USD">): Promise<>  => {
  const flashWallet: WalletDescriptor<"USD"> = //  
  
  const ibexResp = await intraledgerPaymentSendWalletIdForUsdWallet({
    senderAccount: ,
    senderWalletId: sender, 
    recipientWalletId: flashWallet.id,
    amount: Number(amount.amount),

  }) 
  if (ibexResp instanceof Error) return ibexResp 

  // const exchangeRate = 
  // current rate: PriceServer.getRate()
  // quoted rate: redis.getRate(userId)
  const res = await LedgerService().recordCashOut({
    userWalletD: alice.usdWalletD,
    paymentDetails: { // change this type to IbexResponse
      sentAmt: amount,
      receivedAmt: amount,
    },
    liability: {
      amount: 15582n,
      currency: "JMD"
    },
  })

  return ibexResp
}