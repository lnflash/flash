import { GT } from "@graphql/index"

import AdminBroadcastSendPayload from "@graphql/admin/types/payload/admin-broadcast-send"
import BroadcastTag from "@graphql/admin/types/scalar/broadcast-tag"
import { Admin } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

const AdminBroadcastSendInput = GT.Input({
  name: "AdminBroadcastSendInput",
  fields: () => ({
    title: {
      type: GT.NonNull(GT.String),
    },
    body: {
      type: GT.NonNull(GT.String),
    },
    tag: {
      type: GT.NonNull(BroadcastTag),
    },
  }),
})

const AdminBroadcastSendMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      title: string
      body: string
      tag: string
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AdminBroadcastSendPayload),
  args: {
    input: { type: GT.NonNull(AdminBroadcastSendInput) },
  },
  resolve: async (_, args) => {
    const { title, body, tag } = args.input

    const success = await Admin.sendBroadcastNotification({
      title,
      body,
      tag,
    })

    if (success instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(success)] }
    }
    return { errors: [], success: true }
  },
})

export default AdminBroadcastSendMutation
