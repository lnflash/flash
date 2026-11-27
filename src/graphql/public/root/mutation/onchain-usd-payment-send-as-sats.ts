import { PayoutSpeed as DomainPayoutSpeed } from "@domain/bitcoin/onchain"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"

import { Wallets } from "@app/index"
import { authorizeSend } from "@app/payments/authorize-send"
import { usdCentsToDeliverSats } from "@app/payments/usd-cents-for-sats"
import { usdWalletAmountFromWalletId } from "@app/wallets"
import { resolveCashWalletMutationWalletIdForAccount } from "@app/cash-wallet-cutover"

import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
import PayoutSpeed from "@graphql/public/types/scalar/payout-speed"
import Memo from "@graphql/shared/types/scalar/memo"
import OnChainAddress from "@graphql/shared/types/scalar/on-chain-address"
import SatsAmount from "@graphql/shared/types/scalar/sat-amount"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

const OnChainUsdPaymentSendAsBtcDenominatedInput = GT.Input({
  name: "OnChainUsdPaymentSendAsBtcDenominatedInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) },
    address: { type: GT.NonNull(OnChainAddress) },
    amount: { type: GT.NonNull(SatsAmount) },
    speed: {
      type: PayoutSpeed,
      defaultValue: DomainPayoutSpeed.Fast,
    },
    memo: { type: Memo },
  }),
})

const failed = (error: ApplicationError) => ({
  status: PaymentSendStatus.Failure.value,
  errors: [mapAndParseErrorForGqlResponse(error)],
})

// Pays an on-chain request that names its amount in sats, from the Cash wallet.
//
// IBEX sends from a dollar wallet in dollars only, so the sats are priced in
// dollars and rounded UP with a margin (usdCentsToDeliverSats): the recipient
// gets at least what was asked, never less. From there this is the same send as
// onChainUsdPaymentSend, and it follows that resolver step for step.
const OnChainUsdPaymentSendAsBtcDenominatedMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      walletId: WalletId | InputValidationError
      address: OnChainAddress | InputValidationError
      amount: number | InputValidationError
      memo: Memo | InputValidationError | null
      speed: PayoutSpeed | InputValidationError
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(PaymentSendPayload),
  args: {
    input: { type: GT.NonNull(OnChainUsdPaymentSendAsBtcDenominatedInput) },
  },
  resolve: async (_, args, { domainAccount, cashWalletClientCapabilities }) => {
    const { walletId, address, amount, memo, speed } = args.input

    if (walletId instanceof Error) {
      return { errors: [{ message: walletId.message }] }
    }

    if (address instanceof Error) {
      return { errors: [{ message: address.message }] }
    }

    if (amount instanceof Error) {
      return { errors: [{ message: amount.message }] }
    }

    if (memo instanceof Error) {
      return { errors: [{ message: memo.message }] }
    }

    if (speed instanceof Error) {
      return { errors: [{ message: speed.message }] }
    }
    if (!domainAccount) throw new Error("Authentication required")

    const routedWalletId = await resolveCashWalletMutationWalletIdForAccount({
      account: domainAccount,
      walletId,
      client: cashWalletClientCapabilities,
    })
    if (routedWalletId instanceof Error) return failed(routedWalletId)

    // ENG-573 send guard, FIRST and on the amount the caller actually typed:
    // attempt budget, amount sanity and the daily-limit cap all run before the
    // price is read or anything reaches IBEX, and a zero or malformed sat
    // amount is refused (and counted as a strike) by the guard, not here.
    const authorized = await authorizeSend({
      senderAccount: domainAccount,
      senderWalletId: routedWalletId,
      amount: { currency: "BTC", sats: amount },
      kind: "onchain",
    })
    if (authorized instanceof Error) return failed(authorized)

    const converted = await usdCentsToDeliverSats(amount)
    if (converted instanceof Error) return failed(converted)

    const usdAmount = await usdWalletAmountFromWalletId({
      walletId: routedWalletId,
      amount: converted.cents.toString(),
    })
    if (usdAmount instanceof Error) return failed(usdAmount)

    const result = await Wallets.payOnChainByWalletId({
      senderAccount: domainAccount,
      senderWalletId: routedWalletId,
      amount: usdAmount,
      address,
      speed,
      memo,
    })
    if (result instanceof Error) return failed(result)

    return {
      status: result.status.value,
      errors: [],
    }
  },
})

export default OnChainUsdPaymentSendAsBtcDenominatedMutation
