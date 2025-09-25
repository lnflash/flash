import { GT } from "@graphql/index"

const AdminTransactionDetails = GT.Object({
  name: "AdminTransactionDetails",
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
      description: "Payment hash for Lightning transactions",
    },
    paymentPreimage: {
      type: GT.String,
      description: "Payment preimage for Lightning transactions",
    },
    memo: {
      type: GT.String,
      description: "Transaction memo/description",
    },
    // On-chain specific fields
    address: {
      type: GT.String,
      description: "On-chain address",
    },
    txid: {
      type: GT.String,
      description: "On-chain transaction ID",
    },
    vout: {
      type: GT.Int,
      description: "Output index for on-chain transactions",
    },
    confirmations: {
      type: GT.Int,
      description: "Number of confirmations for on-chain transactions",
    },
    fee: {
      type: GT.Float,
      description: "Transaction fee",
    },
  }),
})

export default AdminTransactionDetails
