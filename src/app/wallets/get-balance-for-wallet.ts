import { UnknownLedgerError } from "@domain/ledger"
import { USDAmount } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { IbexError, UnexpectedIbexResponse } from "@services/ibex/errors"

export const getBalanceForWallet = async ({
  walletId,
}: {
  walletId: WalletId
}): Promise<USDAmount | ApplicationError> => {
  // return LedgerService().getWalletBalance(walletId)
  try { 
    const resp = await Ibex.getAccountDetails(walletId)
    if (resp instanceof IbexError) {
      if (resp.httpCode === 404) return USDAmount.ZERO
      return resp
    }
    if (resp.balance === undefined) return new UnexpectedIbexResponse("Balance not found")
    return resp.balance
  } catch (err) {
    return new UnknownLedgerError(err)
  }
}
