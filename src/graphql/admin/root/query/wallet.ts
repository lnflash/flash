import { Wallets } from "@app"
import { GT } from "@graphql/index"
import IWallet from "@graphql/shared/types/abstract/wallet"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

const WalletQuery = GT.Field({
  type: GT.NonNull(IWallet),
  args: {
    walletId: { type: GT.NonNull(WalletId) },
  },
  resolve: async (_, { walletId }) => Wallets.getWallet(walletId),
})

export default WalletQuery
