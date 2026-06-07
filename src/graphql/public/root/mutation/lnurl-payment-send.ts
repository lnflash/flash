import axios from "axios"
import dedent from "dedent"

import { resolveCashWalletMutationWalletIdForAccount } from "@app/cash-wallet-cutover"
import {
  amountMsatFromUsdWalletAmount,
  validateLnurlPayAmountMsat,
} from "@app/payments/lnurl-pay"
import { usdWalletAmountFromWalletId } from "@app/wallets"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
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

const paymentStatusFromIbex = (payment: Record<string, any>): PaymentSendStatus => {
  switch (payment.transaction?.payment?.status?.id) {
    case 1:
      return PaymentSendStatus.Pending
    case 2:
      return PaymentSendStatus.Success
    case 3:
      return PaymentSendStatus.Failure
    default:
      return PaymentSendStatus.Pending
  }
}

const LnurlPaymentSendMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      walletId: WalletId | InputValidationError
      lnurl: Lnurl | InputValidationError
      amount: FractionalCentAmount | InputValidationError
      memo?: Memo | InputValidationError
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
    const { walletId, lnurl, amount, memo } = args.input

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

    const walletAmount = await usdWalletAmountFromWalletId({
      walletId: routedWalletId,
      amount: amount.toString(),
    })
    if (walletAmount instanceof Error) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(walletAmount)],
      }
    }

    const decoded = await Ibex.decodeLnurl({ lnurl })
    if (decoded instanceof IbexError) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(decoded)],
      }
    }
    if (!decoded.decodedLnurl) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(new InvalidLnurlError())],
      }
    }

    const metadataResponse = await axios.get(decoded.decodedLnurl)
    const metadata = metadataResponse.data
    if (!isLnurlPayMetadata(metadata)) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(new InvalidLnurlError())],
      }
    }

    const dealer = DealerPriceService()
    const amountMsat = await amountMsatFromUsdWalletAmount({
      amount: walletAmount,
      btcFromUsd: dealer.getSatsFromCentsForImmediateSell,
    })
    if (amountMsat instanceof Error) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(amountMsat)],
      }
    }

    const validAmount = validateLnurlPayAmountMsat({
      amountMsat,
      minSendable: metadata.minSendable,
      maxSendable: metadata.maxSendable,
    })
    if (validAmount instanceof Error) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(validAmount)],
      }
    }

    const payment = await Ibex.payToLnurl({
      accountId: routedWalletId,
      amountMsat,
      params: paramsFromMetadata(metadata),
    })
    if (payment instanceof IbexError) {
      return {
        status: "failed",
        errors: [mapAndParseErrorForGqlResponse(payment)],
      }
    }

    return {
      errors: [],
      status: paymentStatusFromIbex(payment).value,
    }
  },
})

export default LnurlPaymentSendMutation
