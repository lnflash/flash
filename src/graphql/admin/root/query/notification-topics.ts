import { GT } from "@graphql/index"
import { getNotificationTopics } from "@config"

const NotificationTopicsQuery = GT.Field({
  type: GT.NonNullList(GT.String),
  resolve: () => getNotificationTopics(),
})

export default NotificationTopicsQuery
