import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"
import { checkedToNotificationTopic } from "@domain/notifications"

const NotificationTopic = GT.Scalar({
  name: "NotificationTopic",
  parseValue(value) {
    if (typeof value !== "string") {
      return new InputValidationError({
        message: "Invalid type for NotificationTopic",
      })
    }
    return validNotificationTopic(value)
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.STRING) {
      return validNotificationTopic(ast.value)
    }
    return new InputValidationError({ message: "Invalid type for NotificationTopic" })
  },
})

function validNotificationTopic(value: string): NotificationTopic | InputValidationError {
  const checkedTopic = checkedToNotificationTopic(value)
  if (checkedTopic instanceof Error) {
    return new InputValidationError({ message: checkedTopic.message })
  }
  return checkedTopic
}

export default NotificationTopic
