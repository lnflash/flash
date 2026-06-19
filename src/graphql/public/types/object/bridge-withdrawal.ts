import { GT } from "@graphql/index"
import { getBridgeWithdrawalFlashFeeNoticeForUser } from "@app/bridge/get-withdrawal-flash-fee-notice"
import { isFlashFeeEstimate } from "@services/bridge/withdrawal-fees"

const BridgeWithdrawal = GT.Object({
  name: "BridgeWithdrawal",
  fields: () => ({
    id: { type: GT.NonNullID },
    amount: { type: GT.NonNull(GT.String) },
    currency: { type: GT.NonNull(GT.String) },
    externalAccountId: { type: GT.String },
    status: { type: GT.NonNull(GT.String) },
    estimatedBridgeFeePercent: { type: GT.String },
    estimatedBridgeFee: { type: GT.String },
    estimatedGasBuffer: { type: GT.String },
    estimatedCustomerFee: { type: GT.String },
    flashFeePercent: { type: GT.String },
    flashFee: { type: GT.String },
    flashFeeIsEstimate: { type: GT.NonNull(GT.Boolean) },
    flashFeeNotice: {
      type: GT.String,
      resolve: (parent, _, { user }: GraphQLPublicContext) => {
        const isEstimate =
          parent.flashFeeIsEstimate === true || isFlashFeeEstimate(parent)
        if (!isEstimate) return null
        return getBridgeWithdrawalFlashFeeNoticeForUser(user)
      },
    },
    bridgeDeveloperFee: { type: GT.String },
    bridgeExchangeFee: { type: GT.String },
    subtotalAmount: { type: GT.String },
    finalAmount: { type: GT.String },
    bridgeTransferId: { type: GT.String },
    failureReason: { type: GT.String },
    createdAt: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeWithdrawal
