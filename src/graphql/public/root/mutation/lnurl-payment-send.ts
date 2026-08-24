import { withPaymentIdempotency } from "@app/payments/idempotency"
import axios from "axios"
import dedent from "dedent"

import { resolveCashWalletMutationWalletIdForAccount } from "@app/cash-wallet-cutover"
import {
  amountMsatFromUsdWalletAmount,
  validateLnurlPayAmountMsat,
} from "@app/payments/lnurl-pay"
import { usdWalletAmountFromWalletId } from "@app/wallets"
import { InvalidLnurlError } from "@domain/errors"
import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import PaymentSendPayload from "@graphql/public/types/payload/payment-send"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
import { InputValidationError } from "@graphql/error"
import Lnurl from "@graphql/shared/types/scalar/lnurl"
import Memo from "@graphql/shared/types/scalar/memo"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { DealerPriceService } from "@services/dealer-price"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { lnurlPaymentSendStatusOrPending } from "@services/ibex/payment-status"

type LnurlPayMetadata = {
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  tag?: string
}

const LnurlPaymentSendInput = GT.Input({
  name: "LnurlPaymentSendInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description: "Wallet ID with sufficient balance. Must belong to the current user.",
    },
    lnurl: {
      type: GT.NonNull(Lnurl),
      description: "LNURL-pay value to decode and pay.",
    },
    amount: {
      type: GT.NonNull(FractionalCentAmount),
      description: "Amount to spend from the USD/USDT wallet, in USD cents.",
    },
    memo: {
      type: Memo,
      description: "Optional memo for the Lightning payment.",
    },
    idempotencyKey: {
      type: GT.String,
      description:
        "Optional client-supplied key; a repeated send with the same key returns the original result instead of paying again.",
    },
  }),
})

const isLnurlPayMetadata = (value: unknown): value is LnurlPayMetadata => {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<LnurlPayMetadata>
  return (
    typeof candidate.callback === "string" &&
    Number.isFinite(candidate.minSendable) &&
    Number.isFinite(candidate.maxSendable) &&
    typeof candidate.metadata === "string"
  )
}

const paramsFromMetadata = ({
  callback,
  minSendable,
  maxSendable,
  metadata,
}: LnurlPayMetadata): string =>
  JSON.stringify({
    callback,
    maxSendable,
    minSendable,
    metadata,
    tag: "payRequest",
  })

// Status reading (including the "no recognised status" case) lives in
// @services/ibex/payment-status. payToLnurl gets its own reader there: its 201
// response carries no top-level `status` and no `transaction.payment.status`
// object, and reports settlement via `settleDateUtc` instead.

const LnurlPaymentSendMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      walletId: WalletId | InputValidationError
      lnurl: Lnurl | InputValidationError
      amount: FractionalCentAmount | InputValidationError
      memo?: Memo | InputValidationError
      idempotencyKey?: string | null
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(PaymentSendPayload),
  description: dedent`Pay a LNURL-pay endpoint using a USD/USDT wallet balance.
  The wallet amount is converted to whole-satoshi millisatoshis before calling IBEX.`,
  args: {
    input: { type: GT.NonNull(LnurlPaymentSendInput) },
  },
  resolve: async (_, args, { domainAccount, cashWalletClientCapabilities }) => {
    const { walletId, lnurl, amount, memo, idempotencyKey } = args.input

    if (walletId instanceof InputValidationError) {
      return { status: "failed", errors: [{ message: walletId.message }] }
    }
    if (lnurl instanceof InputValidationError) {
      return { status: "failed", errors: [{ message: lnurl.message }] }
    }
    if (amount instanceof InputValidationError) {
      return { status: "failed", errors: [{ message: amount.message }] }
    }
    if (memo instanceof InputValidationError) {
      return { status: "failed", errors: [{ message: memo.message }] }
    }

    if (!domainAccount) throw new Error("Authentication required")

    const routedWalletId = await resolveCashWalletMutationWalletIdForAccount({
      account: domainAccount,
      walletId,
      client: cashWalletClientCapabilities,
    })
    if (routedWalletId instanceof Error) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(routedWalletId)],
      }
    }

    // ENG-533: direct-IBEX execution, so the exactly-once wrapper never ran on
    // this path. Scoped to the ROUTED wallet. EVERYTHING after routing —
    // decode, metadata fetch, wallet-amount conversion, msat conversion,
    // amount validation and the money-moving call — sits inside execute(), so
    // a cached replay
    // short-circuits before touching IBEX or the lnurl server. That matters
    // precisely on the retry path this wrapper exists for: the flaky lnurl
    // server (or a moved dealer rate) must not be able to mask a cached
    // success as a failure. The fingerprint needs only the client's
    // lnurl + amount (the request as sent) — not amountMsat, which moves with
    // the dealer rate; a legitimate same-key retry must not be rejected as a
    // different payment because the price ticked. Failure branches return
    // ApplicationErrors, which the wrapper never caches, so first-attempt
    // failures stay retryable.
    const outcome = await withPaymentIdempotency({
      idempotencyKey,
      senderWalletId: routedWalletId,
      requestFingerprint: `lnurl|${lnurl}|${amount}`,
      execute: async () => {
        const decoded = await Ibex.decodeLnurl({ lnurl })
        if (decoded instanceof IbexError) return decoded
        if (!decoded.decodedLnurl) return new InvalidLnurlError()

        // A metadata-fetch rejection (non-2xx or network error) must become a
        // typed error like every sibling branch — a bare throw here would
        // propagate through the redlock callback as an unhandled GraphQL error
        // instead of the failed payload.
        let metadata: unknown
        try {
          const metadataResponse = await axios.get(decoded.decodedLnurl)
          metadata = metadataResponse.data
        } catch {
          return new InvalidLnurlError()
        }
        if (!isLnurlPayMetadata(metadata)) return new InvalidLnurlError()

        const walletAmount = await usdWalletAmountFromWalletId({
          walletId: routedWalletId,
          amount: amount.toString(),
        })
        if (walletAmount instanceof Error) return walletAmount

        const dealer = DealerPriceService()
        const amountMsat = await amountMsatFromUsdWalletAmount({
          amount: walletAmount,
          btcFromUsd: dealer.getSatsFromCentsForImmediateSell,
        })
        if (amountMsat instanceof Error) return amountMsat

        const validAmount = validateLnurlPayAmountMsat({
          amountMsat,
          minSendable: metadata.minSendable,
          maxSendable: metadata.maxSendable,
        })
        if (validAmount instanceof Error) return validAmount

        const payment = await Ibex.payToLnurl({
          accountId: routedWalletId,
          amountMsat,
          params: paramsFromMetadata(metadata),
        })
        if (payment instanceof IbexError) return payment
        return lnurlPaymentSendStatusOrPending(payment)
      },
    })

    if (outcome instanceof Error) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(outcome)],
      }
    }

    return {
      errors: [],
      status: outcome.value,
    }
  },
})

export default LnurlPaymentSendMutation
