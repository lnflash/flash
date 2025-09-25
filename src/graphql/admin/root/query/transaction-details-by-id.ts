import { GT } from "@graphql/index"

import { Wallets } from "@app"
import AdminTransactionDetails from "@graphql/admin/types/object/admin-transaction-details"
import { mapError } from "@graphql/error-map"

const TransactionDetailsByIdQuery = GT.Field({
  type: AdminTransactionDetails,
  args: {
    id: { type: GT.NonNullID },
  },
  resolve: async (_, { id }) => {
    if (id instanceof Error) throw id

    const transactionDetails = await Wallets.getTransactionDetailsById(id)
    if (transactionDetails instanceof Error) {
      throw mapError(transactionDetails)
    }

    return transactionDetails
  },
})

export default TransactionDetailsByIdQuery
