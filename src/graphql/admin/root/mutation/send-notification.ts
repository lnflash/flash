import { GT } from "@graphql/index"
import { apolloErrorResponse } from "@graphql/error-map"
import { PushNotificationsService } from "@services/notifications/push-notifications"
import { PushNotificationError } from "@graphql/error"
import IError from "@graphql/shared/types/abstract/error"
import NotificationTopicScalar from "@graphql/admin/types/scalar/notification-topic"
import { SUCCESS_RESPONSE } from "@graphql/shared/types/payload/success-payload"

const SendNotificationInput = GT.Input({
  name: "SendNotificationInput",
  fields: () => ({
    topic: {
      type: GT.NonNull(NotificationTopicScalar),
    },
    title: {
      type: GT.NonNull(GT.String),
    },
    body: {
      type: GT.NonNull(GT.String),
    },
  }),
})

const SendNotificationPayload = GT.Object({
  name: "SendNotificationPayload",
  fields: () => ({
    errors: {
      type: GT.List(IError),
    },
    success: {
      type: GT.Boolean,
    },
  }),
})


const SendNotificationMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      topic: NotificationTopic
      title: string
      body: string
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(SendNotificationPayload),
  args: {
    input: { type: GT.NonNull(SendNotificationInput) },
  },
  resolve: async (_, args) => {
    const { topic, title, body } = args.input

    const firebase = PushNotificationsService()
    const res = await firebase.send({
      topic,
      notification: { title, body },
    })
    if (res instanceof Error) return apolloErrorResponse(new PushNotificationError({ message: "Failed to send push notification(s)", error: res }))

    return SUCCESS_RESPONSE
  },
})

export default SendNotificationMutation
