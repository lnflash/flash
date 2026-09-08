import { PayoutSpeed as DomainPayoutSpeed } from "@domain/bitcoin/onchain"

import { GT } from "@graphql/index"
import Memo from "@graphql/shared/types/scalar/memo"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import OnChainAddress from "@graphql/shared/types/scalar/on-chain-address"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
import PayoutSpeed from "@graphql/public/types/scalar/payout-speed"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

import { Wallets } from "@app"
import { authorizeSend } from "@app/payments/authorize-send"
import { getBalanceForWallet } from "@app/wallets"
import { USDAmount, WalletCurrency } from "@domain/shared"

const OnChainPaymentSendAllInput = GT.Input({
  name: "OnChainPaymentSendAllInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) },
    address: { type: GT.NonNull(OnChainAddress) },
    speed: {
      type: PayoutSpeed,
      defaultValue: DomainPayoutSpeed.Fast,
    },
    memo: { type: Memo },
  }),
})

const OnChainPaymentSendAllMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      walletId: WalletId | InputValidationError
      address: OnChainAddress | InputValidationError
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
    input: { type: GT.NonNull(OnChainPaymentSendAllInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { walletId, address, memo, speed } = args.input

    if (walletId instanceof Error) {
      return { errors: [{ message: walletId.message }] }
    }

    if (address instanceof Error) {
      return { errors: [{ message: address.message }] }
    }

    if (memo instanceof Error) {
      return { errors: [{ message: memo.message }] }
    }

    if (speed instanceof Error) {
      return { errors: [{ message: speed.message }] }
    }

    const amount = await getBalanceForWallet({
      walletId,
      currency: WalletCurrency.Usd,
    })
    if (amount instanceof Error) return amount
    if (!(amount instanceof USDAmount)) {
      return { errors: [{ message: "Onchain payments require a USD wallet" }] }
    }

    // ENG-573 send guard: attempt budget + amount sanity + daily-limit cap,
    // before anything reaches IBEX.
    //
    // Skipped when the balance rounds to zero cents. `getBalanceForWallet`
    // returns `USDAmount.ZERO` for a drained or never-funded wallet as a normal
    // value, not an error — post-cutover that is the default read of every
    // migrated account's legacy USD wallet
    // (@app/wallets/get-balance-for-wallet) — and `asPaymentAmount()` truncates
    // sub-cent dust to the same `0n`. Handed to the guard, that is
    // `invalid-amount`, and in log-only every ordinary empty-wallet tap would
    // land in the one census bucket the runbook calls malformed client input
    // and says should be near zero — during the very sample the enforce
    // decision is made from. That census bucket is the reason for the skip.
    //
    // It is NOT that the rail has a nicer answer. Skipping the guard does not
    // authorise anything: `payOnChainByWalletId` refuses one layer down, at
    // `OnchainUsdPaymentValidator`'s `checkOnchainMin`, which returns a bare
    // `ValidationError("Amount must be greater than 0")` — and `mapError` has
    // no case for that beyond the catch-all, so the client sees "Unexpected
    // error occurred, please try again or contact support if it persists (code:
    // ValidationError: Amount must be greater than 0)". Poor wording, but
    // exactly what this rail returned before ENG-573; fixing it is not the
    // guard's job. Pinned by test/flash/unit/graphql/error-map.spec.ts.
    const cents = amount.asPaymentAmount().amount
    if (cents !== 0n) {
      const authorized = await authorizeSend({
        senderAccount: domainAccount,
        senderWalletId: walletId,
        amount: { currency: "USD", cents },
        kind: "onchain",
      })
      if (authorized instanceof Error) {
        return { status: "failed", errors: [mapAndParseErrorForGqlResponse(authorized)] }
      }
    }

    const result = await Wallets.payOnChainByWalletId({
      senderAccount: domainAccount,
      senderWalletId: walletId,
      amount,
      address,
      speed,
      memo,
    })

    if (result instanceof Error) {
      return { status: "failed", errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return {
      errors: [],
      status: result.status.value,
    }
  },
})

export default OnChainPaymentSendAllMutation
