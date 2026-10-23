import {
  getOwnedWalletSnapshot,
  type OwnedWalletMetadata,
  type OwnedWalletSnapshot,
} from "@app/accounts/owned-wallet-snapshot"
import { GT } from "@graphql/index"
import { AuthenticationError, UnknownClientError } from "@graphql/error"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import WalletCurrency from "@graphql/shared/types/scalar/wallet-currency"

const Metadata = GT.Object<OwnedWalletMetadata>({
  name: "OwnedWalletMetadata",
  description:
    "Actual owned wallet metadata without balances, payment authority or cash presentation aliases.",
  fields: () => ({
    id: { type: GT.NonNull(WalletId) },
    accountId: {
      type: GT.NonNullID,
      description: "Internal wallet-owner ID, distinct from the public account UUID.",
    },
    walletCurrency: { type: GT.NonNull(WalletCurrency) },
    isExternal: { type: GT.NonNull(GT.Boolean) },
  }),
})
const Snapshot = GT.Object<OwnedWalletSnapshot>({
  name: "OwnedWalletSnapshot",
  description:
    "Authenticated raw owner metadata; never performs cash cutover, provisioning or balance reads.",
  fields: () => ({
    publicAccountId: {
      type: GT.NonNullID,
      description: "Public account UUID, matching the enclosing ConsumerAccount.id.",
    },
    walletAccountId: {
      type: GT.NonNullID,
      description: "Internal owner ID shared by these wallet rows.",
    },
    defaultWalletId: {
      type: WalletId,
      description: "Actual stored owned default; null means no stored default.",
    },
    wallets: { type: GT.NonNullList(Metadata) },
  }),
})

export const ownedWalletSnapshotField = GT.Field<Account, GraphQLPublicContextAuth>({
  type: Snapshot,
  description:
    "Raw metadata for this authenticated owner's wallets, without presentation filtering or repair.",
  resolve: async (source, _args, { domainAccount, user }) => {
    const result = await getOwnedWalletSnapshot({
      source,
      account: domainAccount,
      userId: user?.id,
    })
    if (result instanceof Error) {
      if (result.kind === "unauthenticated") throw new AuthenticationError({})
      throw new UnknownClientError({ message: "Owned wallet metadata is unavailable" })
    }
    return result
  },
})
