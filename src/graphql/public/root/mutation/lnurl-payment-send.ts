import { withPaymentIdempotency } from "@app/payments/idempotency"
import { authorizeSend } from "@app/payments/authorize-send"
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
import { baseLogger } from "@services/logger"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { lnurlPaymentSendStatusOrPending } from "@services/ibex/payment-status"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import { ErrorLevel } from "@domain/shared"
import { isSsrfBlockedError, ssrfFetch, validatePublicHttpUrl } from "@utils/ssrf-guard"

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
    //
    // ENG-573 send guard (attempt budget + amount sanity + daily-limit cap) is
    // the wrapper's `authorize` hook rather than a call ahead of it, so a
    // replayed key returns the cached result without spending attempt budget.
    const outcome = await withPaymentIdempotency({
      idempotencyKey,
      senderWalletId: routedWalletId,
      requestFingerprint: `lnurl|${lnurl}|${amount}`,
      authorize: () =>
        authorizeSend({
          senderAccount: domainAccount,
          senderWalletId: routedWalletId,
          amount: { currency: "USD", cents: amount },
          kind: "lnurl",
        }),
      execute: async () => {
        const decoded = await Ibex.decodeLnurl({ lnurl })
        if (decoded instanceof IbexError) return decoded
        if (!decoded.decodedLnurl) return new InvalidLnurlError()

        // The lnurl is straight from the caller's input — the Lnurl scalar
        // validates nothing about the URL it decodes to — so this fetch is the
        // same SSRF hole the LNURL-pay proxy has, from an authenticated but
        // otherwise unprivileged mutation. Every hop goes through the shared
        // guard (@utils/ssrf-guard): https-only, no private/metadata targets,
        // DNS re-checked at connect time, a capped body and one time budget
        // for the whole redirect chain. A bare axios.get here would fetch any
        // in-cluster URL and buffer whatever the host streams back.
        const checkedMetadataUrl = await validatePublicHttpUrl(decoded.decodedLnurl)
        if (checkedMetadataUrl instanceof Error) {
          // Both this branch and the fetch catch below collapse to
          // InvalidLnurlError, and nothing downstream logs: the error map reads
          // only message/path/code, and CustomApolloError binds logger.warn
          // without ever calling it. Unlogged, an authenticated user probing
          // in-cluster hosts and 169.254.169.254 through this mutation leaves no
          // trace to alert on or attribute, and "my LNURL payment says Invalid
          // LNURL" is undiagnosable. The sibling proxy route already logs this
          // (services/ibex/webhook-server/routes/on-pay.ts).
          //
          // The span carries the same event, because https-only is a cutover
          // on a live payments path: a payer whose lnurl decodes to http://
          // used to be paid and now fails, and a log line is not a rate you
          // can alert on.
          recordExceptionInCurrentSpan({
            error: checkedMetadataUrl,
            level: ErrorLevel.Warn,
            fallbackMsg: "lnurlPaymentSend: blocked unsafe lnurl target",
            attributes: {
              "lnurlpay.blocked": true,
              "lnurlpay.blocked.stage": "send-metadata-url",
            },
          })
          baseLogger.warn(
            { err: checkedMetadataUrl, accountId: domainAccount.id },
            "lnurlPaymentSend: blocked unsafe lnurl target",
          )
          return new InvalidLnurlError()
        }

        // A metadata-fetch rejection (non-2xx, a blocked hop, or a network
        // error) must become a typed error like every sibling branch — a bare
        // throw here would propagate through the redlock callback as an
        // unhandled GraphQL error instead of the failed payload.
        let metadata: unknown
        try {
          const metadataResponse = await ssrfFetch(checkedMetadataUrl)
          metadata = metadataResponse.data
        } catch (err) {
          // Which of scheme / DNS / a blocked redirect hop / the 64KB body cap /
          // the 10s budget fired is the whole diagnosis, and it is thrown away
          // without this.
          recordExceptionInCurrentSpan({
            error: err,
            level: ErrorLevel.Warn,
            fallbackMsg: "lnurlPaymentSend: lnurl metadata fetch failed",
            attributes: {
              // Only a refused target is `blocked`. A third-party lnurl server
              // answering 500, a reset connection, an NXDOMAIN — all land in
              // this same catch and are upstream faults, not SSRF refusals.
              // Filing them under the blocked-target signal would break the
              // invariant ssrf-guard.ts establishes deliberately (and its own
              // spec pins): a broken upstream is not a refused target, and an
              // alert on `lnurlpay.blocked` would fire on every flaky wallet
              // host.
              "lnurlpay.blocked": isSsrfBlockedError(err),
              "lnurlpay.blocked.stage": "send-metadata-fetch",
            },
          })
          baseLogger.warn(
            { err, accountId: domainAccount.id },
            "lnurlPaymentSend: lnurl metadata fetch failed",
          )
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
