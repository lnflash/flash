import { checkedToBroadcastTag } from "@domain/notifications"

import { NotificationsService } from "@services/notifications"
import { User } from "@services/mongoose/schema"

export const sendBroadcastNotification = async ({
  title,
  body,
  tag,
}: {
  title: string
  body: string
  tag: string
}): Promise<true | ApplicationError> => {
  // Validate broadcast tag
  const broadcastTag = checkedToBroadcastTag(tag)
  if (broadcastTag instanceof Error) return broadcastTag

  // Fetch all users with device tokens
  const users = await User.find(
    { deviceTokens: { $exists: true, $not: { $size: 0 } } },
    { deviceTokens: 1 },
  ).lean()

  if (!users || users.length === 0) return true

  // Collect all device tokens from all users
  const allDeviceTokens: DeviceToken[] = users.flatMap(
    (user) => user.deviceTokens as DeviceToken[],
  )

  if (allDeviceTokens.length === 0) return true

  // Send broadcast notification with tag in data
  const result = await NotificationsService().sendBroadcast({
    deviceTokens: allDeviceTokens,
    title,
    body,
    data: { tag: broadcastTag },
  })

  return result
}
