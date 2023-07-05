import mongoose from "mongoose"

const ExternalWalletSchema = new mongoose.Schema(
  {
    accountId: {
      type: String,
      required: true,
    },
    externalId: {
      type: String,
      required: true,
    },
    externalUserId: {
      type: String,
      required: true,
    },
    organizationId: {
      type: String,
      required: true,
    },
    currencyId: {
      type: Number,
      required: true,
    },
  },
  { collection: "wallets" },
)

const ExternalWallet = mongoose.model("ExternalWallet", ExternalWalletSchema)

export default ExternalWallet
