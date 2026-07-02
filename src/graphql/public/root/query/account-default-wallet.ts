import { resolveCashWalletPresentationForAccount } from "@app/cash-wallet-cutover"
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
      return presentation.wallets.find(
        (wallet) => wallet.id === presentation.defaultWalletId,
      )
    }

    const wallet = presentation.wallets.find(
      (wallet) => wallet.currency === walletCurrency,
    )
    if (!wallet) {
      throw mapError(new CouldNotFindWalletFromUsernameAndCurrencyError(username))
    }

    return wallet
  },
})

export default AccountDefaultWalletQuery
