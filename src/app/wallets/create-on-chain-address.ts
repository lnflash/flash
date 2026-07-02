/*
  FLASH FORK
  Origin Galoy code contained additional logic to lookup by requestId, check addresses on-chain, and check account limits. 
  Check Git history for missing functionality 
*/
import { AccountValidator } from "@domain/accounts"
import Ibex from "@services/ibex/client"
import { IbexError, UnexpectedIbexResponse } from "@services/ibex/errors"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"

export const createOnChainAddress = async ({
  walletId,
}: {
  walletId: WalletId
  requestId?: OnChainAddressRequestId
}) => {
  const wallet = await WalletsRepository().findById(walletId)
  if (wallet instanceof Error) return wallet
  const account = await AccountsRepository().findById(wallet.accountId)
  if (account instanceof Error) return account
  const accountValidator = AccountValidator(account).isActive()
  if (accountValidator instanceof Error) return accountValidator

  const resp = await Ibex.generateBitcoinAddress(walletId)
  if (resp instanceof IbexError) return resp
  else if (!resp.address) return new UnexpectedIbexResponse("Address not returned")
  else return resp.address
}
