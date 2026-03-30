import { checkedToDeviceToken } from "@domain/users"
import { UsersRepository } from "@services/mongoose"
import firebase from "@services/notifications/firebase"

export const addDeviceToken = async ({
  userId,
  deviceToken,
}: AddDeviceTokenArgs): Promise<User | ApplicationError> => {
  const users = UsersRepository()

  const deviceTokenChecked = await checkedToDeviceToken(deviceToken)
  if (deviceTokenChecked instanceof Error) return deviceTokenChecked

  const user = await users.findById(userId)
  if (user instanceof Error) return user

  const { deviceTokens, notificationTopics } = user

  if (!deviceTokens.includes(deviceTokenChecked)) {
    deviceTokens.push(deviceTokenChecked)
    firebase.subscribeToTopics(deviceTokenChecked, notificationTopics)
  }

  return users.update({ ...user, deviceTokens })
}
