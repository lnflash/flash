import { GT } from "@graphql/index"
import { TransactionDetails } from "@graphql/shared/types/object/transaction-details"

const TransactionDetailsPayload = GT.Object({
  name: "TransactionDetailsPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(
        GT.Object({
          name: "TransactionDetailsError",
          fields: () => ({
            message: {
              type: GT.NonNull(GT.String),
            },
          }),
        }),
      ),
    },
    transactionDetails: {
      type: TransactionDetails,
    },
  }),
})

export { TransactionDetailsPayload }
