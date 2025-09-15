import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapError } from "@graphql/error-map"
import InviteStatistics from "@graphql/admin/types/object/invite-statistics"

const InviteStatisticsQuery = GT.Field({
  type: GT.NonNull(InviteStatistics),
  resolve: async () => {
    const statistics = await Admin.getInviteStatistics()
    
    if (statistics instanceof Error) {
      throw mapError(statistics)
    }

    return statistics
  },
})

export default InviteStatisticsQuery