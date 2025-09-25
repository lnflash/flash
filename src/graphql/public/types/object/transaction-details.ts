import { GT } from "@graphql/index"

const TransactionDetails = GT.Object({
  name: "TransactionDetails",
  fields: () => ({
    id: {
      type: GT.NonNull(GT.String),
      description: "Transaction ID",
    },
    accountId: {
      type: GT.String,
      description: "Account ID associated with the transaction",
    },
    amount: {
      type: GT.Float,
      description: "Transaction amount",
    },
    currency: {
      type: GT.String,
      description: "Transaction currency",
    },
    status: {
      type: GT.String,
      description: "Transaction status",
    },
    type: {
      type: GT.String,
      description: "Transaction type (lightning/onchain)",
    },
    createdAt: {
      type: GT.String,
      description: "Transaction creation timestamp",
    },
    updatedAt: {
      type: GT.String,
      description: "Transaction last update timestamp",
    },
    // Lightning specific fields
    invoice: {
      type: GT.String,
      description: "Lightning invoice (bolt11)",
    },
    paymentHash: {
      type: GT.String,
      description: "Lightning payment hash",
    },
    paymentPreimage: {
      type: GT.String,
      description: "Lightning payment preimage",
    },
    memo: {
      type: GT.String,
      description: "Transaction memo/description",
    },
    // Onchain specific fields
    address: {
      type: GT.String,
      description: "Bitcoin address for onchain transactions",
    },
    txid: {
      type: GT.String,
      description: "Bitcoin transaction ID for onchain transactions",
    },
    vout: {
      type: GT.Int,
      description: "Output index for onchain transactions",
    },
    confirmations: {
      type: GT.Int,
      description: "Number of confirmations for onchain transactions",
    },
    fee: {
      type: GT.Float,
      description: "Transaction fee",
    },
  }),
})

export { TransactionDetails }
