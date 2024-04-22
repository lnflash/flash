/*
  FLASH FORK
  Origin Galoy code contained additional logic to lookup by requestId, check addresses on-chain, and check account limits. 
  Check Git history for missing functionality 
*/
import { AccountValidator } from "@domain/accounts"
import {
  AccountsRepository,
  WalletsRepository,
} from "@services/mongoose"
import { client as Ibex } from "@services/ibex"
import { IbexClientError } from "@services/ibex/client/errors"

export const createOnChainAddress = async ({
    walletId,
    requestId, // TODO: Check uses of this unused parameter for potential bugs
  }: {
    walletId: WalletId
    requestId?: OnChainAddressRequestId
  }) => {
    const wallet = await WalletsRepository().findById(walletId)
    if (wallet instanceof Error) return wallet
    const account = await AccountsRepository().findById(wallet.accountId)
    if (account instanceof Error) return account
    const accountValidator = AccountValidator(account)
    if (accountValidator instanceof Error) return accountValidator
    
    const resp = await Ibex().generateBitcoinAddress({ accountId: walletId })
    if (resp instanceof IbexClientError) return resp
    else if (!resp.address) return new IbexClientError("Address not returned")
    else return resp.address
  }
