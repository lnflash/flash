import { GT } from "@graphql/index"

const InviteStatistics = GT.Object({
  name: "InviteStatistics",
  fields: () => ({
    totalSent: {
      type: GT.NonNull(GT.Int),
    },
    totalRedeemed: {
      type: GT.NonNull(GT.Int),
    },
    totalPending: {
      type: GT.NonNull(GT.Int),
    },
    redemptionRate: {
      type: GT.NonNull(GT.Float),
    },
  }),
})

export default InviteStatistics