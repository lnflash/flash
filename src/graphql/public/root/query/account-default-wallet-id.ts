import { resolveCashWalletPresentationForAccount } from "@app/cash-wallet-cutover"
import { mapError } from "@graphql/error-map"
import { GT } from "@graphql/index"
import Username from "@graphql/shared/types/scalar/username"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { AccountsRepository } from "@services/mongoose"

const AccountDefaultWalletIdQuery = GT.Field<null, GraphQLPublicContext>({
  deprecationReason: "will be migrated to AccountDefaultWalletId",
  type: GT.NonNull(WalletId),
  args: {
    username: {
      type: GT.NonNull(Username),
    },
  },
  resolve: async (_, args, { cashWalletClientCapabilities }) => {
    const { username } = args

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

    return presentation.defaultWalletId
  },
})

export default AccountDefaultWalletIdQuery
