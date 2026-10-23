import { address, networks } from "bitcoinjs-lib"

import {
  CashWalletClientCapabilities,
  resolveCashWalletMutationWalletIdForAccount,
} from "@app/cash-wallet-cutover"
import { NETWORK } from "@config"
import { AccountValidator, InvalidWalletForAccountError } from "@domain/accounts"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import Ibex from "@services/ibex/client"
import { IbexError, UnexpectedIbexResponse } from "@services/ibex/errors"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"

/** IBEX on-chain receive is for an active owner's cash checking wallet. */
export const createOwnedOnChainAddress = async ({
  accountId,
  walletId,
  client,
}: {
  accountId: AccountId
  walletId: WalletId
  client: CashWalletClientCapabilities
}): Promise<OnChainAddress | ApplicationError | IbexError> => {
  const wallet = await WalletsRepository().findById(walletId)
  // Use one refusal for absent, foreign, external, and wrong-currency wallets.
  if (
    wallet instanceof Error ||
    wallet.accountId !== accountId ||
    wallet.type !== WalletType.Checking ||
    (wallet.currency !== WalletCurrency.Usd && wallet.currency !== WalletCurrency.Usdt)
  ) {
    return new InvalidWalletForAccountError()
  }

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account
  if (account.id !== accountId) return new InvalidWalletForAccountError()
  const active = AccountValidator(account).isActive()
  if (active instanceof Error) return active

  // The presented USD wallet can be an alias for the active USDT settlement
  // wallet after cutover. Prove ownership and active account status before
  // resolving that alias, because resolution may self-heal a missing wallet.
  const routedWalletId = await resolveCashWalletMutationWalletIdForAccount({
    account,
    walletId,
    client,
  })
  if (routedWalletId instanceof Error) return routedWalletId

  if (routedWalletId !== walletId) {
    const routedWallet = await WalletsRepository().findById(routedWalletId)
    if (
      routedWallet instanceof Error ||
      routedWallet.accountId !== accountId ||
      routedWallet.type !== WalletType.Checking ||
      routedWallet.currency !== WalletCurrency.Usdt
    ) {
      return new InvalidWalletForAccountError()
    }
  }

  const response = await Ibex.generateBitcoinAddress(routedWalletId)
  if (response instanceof IbexError) return response
  const value = response.address
  if (typeof value !== "string")
    return new UnexpectedIbexResponse("Bitcoin address unavailable")
  try {
    // bitcoinjs verifies the checksum and the configured chain, rather than
    // relying on an address prefix or an untrusted provider response.
    const network =
      NETWORK === "mainnet"
        ? networks.bitcoin
        : NETWORK === "regtest"
          ? networks.regtest
          : networks.testnet // signet uses testnet address encoding.
    address.toOutputScript(value, network)
    return value as OnChainAddress
  } catch {
    return new UnexpectedIbexResponse("Bitcoin address unavailable")
  }
}
