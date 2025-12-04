import { GT } from "@graphql/index"
import { Wallets } from "@app"
import { mapError } from "@graphql/error-map"
import { TransactionDetailsPayload } from "@graphql/public/types/payload/transaction-details"

const TransactionDetailsInput = GT.Input({
  name: "TransactionDetailsInput",
  fields: () => ({
    transactionId: {
      type: GT.NonNull(GT.String),
      description: "Transaction ID to fetch details for",
    },
  }),
})

const TransactionDetailsQuery = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(TransactionDetailsPayload),
  args: {
    input: { type: GT.NonNull(TransactionDetailsInput) },
  },
  resolve: async (_, args) => {
    const { transactionId } = args.input

    const transactionDetails = await Wallets.getTransactionDetailsById(transactionId)

    if (transactionDetails instanceof Error) {
      return {
        errors: [mapError(transactionDetails)],
      }
    }

    return {
      errors: [],
      transactionDetails,
    }
  },
})

export default TransactionDetailsQuery
