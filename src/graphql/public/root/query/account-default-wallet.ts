import { resolveCashWalletPresentationForAccount } from "@app/cash-wallet-cutover"
import {
  ensureReceiveAccount,
  hasEnabledSplits,
} from "@app/payment-splits/receive-account"
import { CouldNotFindWalletFromUsernameAndCurrencyError } from "@domain/errors"
import { mapError } from "@graphql/error-map"
import { GT } from "@graphql/index"
import Username from "@graphql/shared/types/scalar/username"
import WalletCurrency from "@graphql/shared/types/scalar/wallet-currency"
import PublicWallet from "@graphql/public/types/abstract/public-wallet"
import { AccountsRepository } from "@services/mongoose"

const AccountDefaultWalletQuery = GT.Field<null, GraphQLPublicContext>({
  type: GT.NonNull(PublicWallet),
  args: {
    username: {
      type: GT.NonNull(Username),
    },
    walletCurrency: { type: WalletCurrency },
  },
  resolve: async (_, args, { cashWalletClientCapabilities }) => {
    const { username, walletCurrency } = args

    if (username instanceof Error) {
      throw username
    }

    const account = await AccountsRepository().findByUsername(username)
    if (account instanceof Error) {
      throw mapError(account)
    }

    const presentation = await resolveCashWalletPresentationForAccount({
      account,
      client: cashWalletClientCapabilities,
    })
    if (presentation instanceof Error) throw mapError(presentation)

    if (!walletCurrency) {
      return withShadowLnurlp(
        presentation.wallets.find((wallet) => wallet.id === presentation.defaultWalletId),
      )
    }

    const wallet = presentation.wallets.find(
      (wallet) => wallet.currency === walletCurrency,
    )
    if (!wallet) {
      throw mapError(new CouldNotFindWalletFromUsernameAndCurrencyError(username))
    }

    return withShadowLnurlp(wallet)
  },
})

/**
 * ENG-717: while a wallet has enabled split rules, its Lightning address
 * serves the SHADOW receive account's LNURL-pay, so external pays settle on
 * the shadow and fan out (flash-pay reads THIS field; it must not cache the
 * answer — see its no-cache change). Fail-safe: any error resolving the
 * shadow leaves the wallet's own lnurlp — an unsplit receive, never a failed
 * lookup.
 */
const withShadowLnurlp = async (
  wallet: Wallet | undefined,
): Promise<Wallet | undefined> => {
  if (!wallet) return wallet

  const enabled = await hasEnabledSplits(wallet.id)
  if (enabled !== true) return wallet

  const shadow = await ensureReceiveAccount({
    walletId: wallet.id,
    currency: wallet.currency,
  })
  if (shadow instanceof Error || !shadow.lnurlp) return wallet

  return { ...wallet, lnurlp: shadow.lnurlp as Lnurl }
}

export default AccountDefaultWalletQuery
