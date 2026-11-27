import { PayoutSpeed as DomainPayoutSpeed } from "@domain/bitcoin/onchain"

import { usdCentsToDeliverSats } from "@app/payments/usd-cents-for-sats"
import { usdWalletAmountFromWalletId } from "@app/wallets"

import { GT } from "@graphql/index"
import { mapError } from "@graphql/error-map"

import OnChainAddress from "@graphql/shared/types/scalar/on-chain-address"
import PayoutSpeed from "@graphql/public/types/scalar/payout-speed"
import SatAmount from "@graphql/shared/types/scalar/sat-amount"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

import OnChainUsdTxFee from "@graphql/public/types/object/onchain-usd-tx-fee"

// FLASH FORK: the fee comes from IBEX, as it does for onChainUsdTxFee.
import Ibex from "@services/ibex/client"
import { IbexError, UnexpectedIbexResponse } from "@services/ibex/errors"

// The fee for paying a sat-denominated on-chain request from the Cash wallet.
// The sats are priced in dollars first (see usdCentsToDeliverSats), because
// IBEX only estimates and sends in the wallet's own currency; the estimate is
// then the same call onChainUsdTxFee makes. The amount it is estimated for is
// the one onChainUsdPaymentSendAsBtcDenominated will actually send.
const OnChainUsdTxFeeAsBtcDenominatedQuery = GT.Field<null, GraphQLPublicContextAuth>({
  type: GT.NonNull(OnChainUsdTxFee),
  args: {
    walletId: { type: GT.NonNull(WalletId) },
    address: { type: GT.NonNull(OnChainAddress) },
    amount: { type: GT.NonNull(SatAmount) },
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

    const converted = await usdCentsToDeliverSats(amount)
    if (converted instanceof Error) throw mapError(converted)

    const send = await usdWalletAmountFromWalletId({
      walletId,
      amount: converted.cents.toString(),
    })
    if (send instanceof Error) throw mapError(send)

    const resp = await Ibex.estimateOnchainFee(send, address)
    if (resp instanceof IbexError) throw mapError(resp)
    if (resp.fee === undefined) {
      throw mapError(new UnexpectedIbexResponse("Missing fee field"))
    }

    return {
      amount: resp.fee,
    }
  },
})

export default OnChainUsdTxFeeAsBtcDenominatedQuery
