import { GT } from "@graphql/index"
import { getFCMTopics } from "@config"

const NotificationTopicsQuery = GT.Field({
  type: GT.NonNullList(GT.String),
  resolve: () => getFCMTopics(),
})

export default NotificationTopicsQuery
