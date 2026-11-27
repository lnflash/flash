import { PayoutSpeed as DomainPayoutSpeed } from "@domain/bitcoin/onchain"
import { usdWalletAmountFromWalletId } from "@app/wallets"

import { GT } from "@graphql/index"
import { mapError } from "@graphql/error-map"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
import OnChainAddress from "@graphql/shared/types/scalar/on-chain-address"
import PayoutSpeed from "@graphql/public/types/scalar/payout-speed"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

import OnChainUsdTxFee from "@graphql/public/types/object/onchain-usd-tx-fee"

// FLASH FORK: import ibex dependencies
import Ibex from "@services/ibex/client"

import { IbexError } from "@services/ibex/errors"
import { onChainFeeCentsFromIbex } from "@services/ibex/on-chain-fee"

const OnChainUsdTxFeeQuery = GT.Field<null, GraphQLPublicContextAuth>({
  type: GT.NonNull(OnChainUsdTxFee),
  args: {
    walletId: { type: GT.NonNull(WalletId) },
    address: { type: GT.NonNull(OnChainAddress) },
    amount: { type: GT.NonNull(FractionalCentAmount) },
    speed: {
      type: PayoutSpeed,
      defaultValue: DomainPayoutSpeed.Fast,
    },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { walletId, address, amount, speed } = args
    for (const input of [walletId, address, amount, speed]) {
      if (input instanceof Error) throw input
    }
    if (!domainAccount) throw new Error("Authentication required")
    // FLASH FORK: use IBEX to send on-chain payment
    // const fee = await Wallets.getOnChainFeeForUsdWallet({
    //   walletId,
    //   account: domainAccount as Account,
    //   amount,
    //   address,
    //   speed,
    // })

    const send = await usdWalletAmountFromWalletId({
      walletId,
      amount: amount.toString(),
    })
    if (send instanceof Error) throw mapError(send)
    const resp = await Ibex.estimateOnchainFee(send, address)

    if (resp instanceof IbexError) throw mapError(resp)

    // IBEX names the fee in dollars; this field is cents.
    const feeCents = onChainFeeCentsFromIbex(resp)
    if (feeCents instanceof Error) throw mapError(feeCents)

    return {
      amount: feeCents,
    }
  },
})

export default OnChainUsdTxFeeQuery
