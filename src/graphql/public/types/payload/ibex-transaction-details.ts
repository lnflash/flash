import { GT } from "@graphql/index"
import { IbexTransactionDetails } from "@graphql/public/types/object/ibex-transaction-details"

const IbexTransactionDetailsPayload = GT.Object({
  name: "IbexTransactionDetailsPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(
        GT.Object({
          name: "IbexTransactionDetailsError",
          fields: () => ({
            message: {
              type: GT.NonNull(GT.String),
            },
          }),
        }),
      ),
    },
    transactionDetails: {
      type: IbexTransactionDetails,
    },
  }),
})

export { IbexTransactionDetailsPayload }
