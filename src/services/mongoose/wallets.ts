import {
  CouldNotFindWalletFromIdError,
  CouldNotFindWalletFromOnChainAddressError,
  CouldNotFindWalletFromOnChainAddressesError,
  CouldNotListWalletsFromAccountIdError,
  CouldNotListWalletsFromWalletCurrencyError,
  RepositoryError,
} from "@domain/errors"
import { Types } from "mongoose"

// FLASH FORK: import IBEX routes and helper
import { client as Ibex } from "@services/ibex"
import { IbexClientError } from "@services/ibex/client/errors"

import { toObjectId, fromObjectId, parseRepositoryError } from "./utils"
import { Wallet } from "./schema"
import { AccountsRepository } from "./accounts"
import { baseLogger } from "@services/logger"

export interface WalletRecord {
  id: string
  _accountId: Types.ObjectId
  type: string
  currency: string
  onchain: OnChainMongooseType[]
  lnurlp: string
}

export const WalletsRepository = (): IWalletsRepository => {
  const persistNew = async ({
    accountId,
    type,
    currency,
  }: NewWalletInfo): Promise<Wallet | RepositoryError> => {
    const account = await AccountsRepository().findById(accountId)
    // verify that the account exist
    if (account instanceof Error) return account
    try {
      // FLASH FORK: create IBEX account if currency is USD
      let ibexAccountId: string | undefined
      if (currency === "USD") {
        const resp = await Ibex().createAccount({
          name: accountId,
          currencyId: 3,
        })
        if (resp instanceof IbexClientError) return resp
        ibexAccountId = resp.id 
      }
 
      let lnurlp: string | undefined
      if (ibexAccountId !== undefined) {
        const lnurlResp = await Ibex().createLnurlPay({ accountId: ibexAccountId })
        if (lnurlResp instanceof IbexClientError) baseLogger.error(lnurlResp, `Failed to create lnurl-pay address for ibex account with id ${ibexAccountId}`)
        else lnurlp = lnurlResp.lnurl
      }
      
      const wallet = new Wallet({
        _accountId: toObjectId<AccountId>(accountId),
        id: ibexAccountId || crypto.randomUUID(), // Why are we creating a random id rather than failing? 
        type,
        currency,
        lnurlp
      })
      await wallet.save()
      return resultToWallet(wallet)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const findById = async (walletId: WalletId): Promise<Wallet | RepositoryError> => {
    try {
      const result: WalletRecord | null = await Wallet.findOne({ id: walletId })
      if (!result) {
        return new CouldNotFindWalletFromIdError()
      }
      return resultToWallet(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const listByAccountId = async (
    accountId: AccountId,
  ): Promise<Wallet[] | RepositoryError> => {
    try {
      const result: WalletRecord[] = await Wallet.find({
        _accountId: toObjectId<AccountId>(accountId),
      })
      if (!result || result.length === 0) {
        return new CouldNotListWalletsFromAccountIdError(`accountId: ${accountId}}`)
      }
      return result.map(resultToWallet)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const findByAddress = async (
    address: OnChainAddress,
  ): Promise<Wallet | RepositoryError> => {
    try {
      const result: WalletRecord | null = await Wallet.findOne({
        "onchain.address": address,
      })
      if (!result) {
        return new CouldNotFindWalletFromOnChainAddressError()
      }
      return resultToWallet(result)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const listByAddresses = async (
    addresses: OnChainAddress[],
  ): Promise<Wallet[] | RepositoryError> => {
    try {
      const result: WalletRecord[] = await Wallet.find({
        "onchain.address": { $in: addresses },
      })
      if (!result || result.length === 0) {
        return new CouldNotFindWalletFromOnChainAddressesError()
      }
      return result.map(resultToWallet)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }
  // TODO: future performance improvement might be needed
  // add pagination for instance which would have millions of wallets
  const listByWalletCurrency = async (
    walletCurrency: WalletCurrency,
  ): Promise<Wallet[] | RepositoryError> => {
    try {
      const result = await Wallet.find({ currency: walletCurrency })
      if (!result) {
        return new CouldNotListWalletsFromWalletCurrencyError()
      }
      return result.map(resultToWallet)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  return {
    findById,
    listByAccountId,
    findByAddress,
    listByAddresses,
    persistNew,
    listByWalletCurrency,
  }
}

const resultToWallet = (result: WalletRecord): Wallet => {
  const id = result.id as WalletId
  const accountId = fromObjectId<AccountId>(result._accountId)
  const type = result.type as WalletType
  const currency = result.currency as WalletCurrency
  const lnurlp = result.lnurlp as Lnurl
  const onChain = result.onchain || []
  const onChainAddressIdentifiers = onChain.map(({ pubkey, address }) => {
    return {
      pubkey: pubkey as Pubkey,
      address: address as OnChainAddress,
    }
  })
  const onChainAddresses = () => onChainAddressIdentifiers.map(({ address }) => address)

  return {
    id,
    accountId,
    type,
    onChainAddressIdentifiers,
    onChainAddresses,
    currency,
    lnurlp,
  }
}
