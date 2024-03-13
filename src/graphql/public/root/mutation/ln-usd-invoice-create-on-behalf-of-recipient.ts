import dedent from "dedent"

// import { Wallets } from "@app"

import { GT } from "@graphql/index"
import Memo from "@graphql/shared/types/scalar/memo"
import Minutes from "@graphql/public/types/scalar/minutes"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import Hex32Bytes from "@graphql/public/types/scalar/hex32bytes"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import LnInvoicePayload from "@graphql/public/types/payload/ln-invoice"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

// FLASH FORK: import ibex dependencies
import { decodeInvoice } from "@domain/bitcoin/lightning"

import { client as Ibex } from "@services/ibex"
import { IbexClientError, UnexpectedResponseError } from "@services/ibex/client/errors"

const LnUsdInvoiceCreateOnBehalfOfRecipientInput = GT.Input({
  name: "LnUsdInvoiceCreateOnBehalfOfRecipientInput",
  fields: () => ({
    recipientWalletId: {
      type: GT.NonNull(WalletId),
      description: "Wallet ID for a USD wallet which belongs to the account of any user.",
    },
    amount: { type: GT.NonNull(CentAmount), description: "Amount in USD cents." },
    memo: {
      type: Memo,
      description:
        "Optional memo for the lightning invoice. Acts as a note to the recipient.",
    },
    descriptionHash: { type: Hex32Bytes },
    expiresIn: {
      type: Minutes,
      description: "Optional invoice expiration time in minutes.",
    },
  }),
})

const LnUsdInvoiceCreateOnBehalfOfRecipientMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(LnInvoicePayload),
  description: dedent`Returns a lightning invoice denominated in satoshis for an associated wallet.
  When invoice is paid the equivalent value at invoice creation will be credited to a USD wallet.
  Expires after 'expiresIn' or 5 minutes (short expiry time because there is a USD/BTC exchange rate
    associated with the amount).`,
  args: {
    input: { type: GT.NonNull(LnUsdInvoiceCreateOnBehalfOfRecipientInput) },
  },
  resolve: async (_, args) => {
    const { recipientWalletId, amount, memo, descriptionHash, expiresIn } = args.input
    for (const input of [recipientWalletId, amount, memo, descriptionHash, expiresIn]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    // FLASH FORK: create IBEX invoice instead of Galoy invoice
    const resp = await Ibex.addInvoice({
      amount: amount / 100,
      accountId: recipientWalletId,
      memo,
      expiration: expiresIn,
    })

    if (resp instanceof IbexClientError) {
      return { errors: [mapAndParseErrorForGqlResponse(resp)] }
    }

    const invoiceString: string | undefined = resp.invoice?.bolt11
    if (!invoiceString) {
      return {
        errors: [
          mapAndParseErrorForGqlResponse(
            new UnexpectedResponseError("Could not find invoice."),
          ),
        ],
      }
    }
    const decodedInvoice = decodeInvoice(invoiceString)
    if (decodedInvoice instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(decodedInvoice)] }
    }

    // const invoice = await Wallets.addInvoiceForRecipientForUsdWallet({
    //   recipientWalletId,
    //   amount,
    //   memo,
    //   descriptionHash,
    //   expiresIn,
    // })

    // if (invoice instanceof Error) {
    //   return { errors: [mapAndParseErrorForGqlResponse(invoice)] }
    // }

    return {
      errors: [],
      invoice: {
        destination: decodedInvoice.destination,
        paymentHash: decodedInvoice.paymentHash,
        paymentRequest: decodedInvoice.paymentRequest,
        paymentSecret: decodedInvoice.paymentSecret,
        milliSatsAmount: decodedInvoice.milliSatsAmount,
        description: decodedInvoice.description,
        cltvDelta: decodedInvoice.cltvDelta,
        amount: null,
        paymentAmount: null,
        routeHints: decodedInvoice.routeHints,
        features: decodedInvoice.features,
        expiresAt: decodedInvoice.expiresAt,
        isExpired: decodedInvoice.isExpired,
      },
    }
  },
})

export default LnUsdInvoiceCreateOnBehalfOfRecipientMutation
