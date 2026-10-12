import { GT } from "@graphql/index"
import { mapError } from "@graphql/error-map"

import { getPaymentSplits } from "@app/payment-splits/get-splits"

import Timestamp from "../scalar/timestamp"
import WalletId from "../scalar/wallet-id"

type WalletSplitSource = {
  id: string
  destinationWalletId: string
  percent: number
  enabled: boolean
  createdAt: Date
}

const WalletSplit = GT.Object<WalletSplitSource>({
  name: "WalletSplit",
  description:
    "A payment split rule: this percentage of every external Lightning receive on the wallet is paid on to the destination wallet.",
  fields: () => ({
    id: { type: GT.NonNullID },
    destinationWalletId: { type: GT.NonNull(WalletId) },
    percent: {
      type: GT.NonNull(GT.Int),
      description: "Whole percent of each receive, from 1 to 100.",
    },
    enabled: { type: GT.NonNull(GT.Boolean) },
    createdAt: { type: GT.NonNull(Timestamp) },
  }),
})

/**
 * Resolver for the `splits` field on UsdWallet/UsdtWallet. Split rules are
 * private to the wallet's owner: a session whose account does not own the
 * wallet gets an empty list.
 */
export const resolveWalletSplits = async (
  source: Wallet,
  _args: unknown,
  ctx: unknown,
): Promise<WalletSplitSource[]> => {
  const domainAccount = (ctx as { domainAccount?: { id: string } } | undefined)
    ?.domainAccount
  if (domainAccount && domainAccount.id !== source.accountId) return []

  const splits = await getPaymentSplits(source.id)
  if (splits instanceof Error) throw mapError(splits)
  return splits
}

export default WalletSplit
