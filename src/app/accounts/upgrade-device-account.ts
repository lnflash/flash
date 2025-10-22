import { AccountLevel } from "@domain/accounts"
import { AccountsRepository, UsersRepository } from "@services/mongoose"

export const upgradeAccountFromDeviceToPhone = async ({
  userId,
  phone,
  phoneMetadata,
}: {
  userId: UserId
  phone: PhoneNumber
  phoneMetadata?: PhoneMetadata
}): Promise<Account | RepositoryError> => {
  // TODO: ideally both 1. and 2. should be done in a transaction,
  // so that if one fails, the other is rolled back

  // Update user
  const userUpdated = await UsersRepository().findById(userId)
  if (userUpdated instanceof Error) return userUpdated
  userUpdated.phone = phone

  const res = await UsersRepository().update({ ...userUpdated, phoneMetadata })
  if (res instanceof Error) return res

  // Update account
  const accountDevice = await AccountsRepository().findByUserId(userUpdated.id)
  if (accountDevice instanceof Error) return accountDevice
  accountDevice.level = AccountLevel.One
  const accountUpdated = await AccountsRepository().update(accountDevice)
  if (accountUpdated instanceof Error) return accountUpdated

  return accountUpdated
}

/**
 * Upgrades a TRIAL device account to an email-based account
 *
 * This function updates MongoDB records after Kratos schema has been upgraded
 * from username_password_deviceid_v0 to email_no_password_v0
 *
 * Changes made:
 * - Adds email to User record
 * - Upgrades Account level from 0 (TRIAL) to 1 (verified)
 * - Preserves deviceId field in User record
 *
 * @param userId - Kratos user ID
 * @param email - Email address to add
 * @returns Updated Account or RepositoryError
 */
export const upgradeAccountFromDeviceToEmail = async ({
  userId,
  email,
}: {
  userId: UserId
  email: EmailAddress
}): Promise<Account | RepositoryError> => {
  // TODO: ideally both 1. and 2. should be done in a transaction,
  // so that if one fails, the other is rolled back

  // 1. Update user record with email (deviceId is preserved via spread)
  const userUpdated = await UsersRepository().findById(userId)
  if (userUpdated instanceof Error) return userUpdated
  userUpdated.email = email

  const res = await UsersRepository().update(userUpdated)
  if (res instanceof Error) return res

  // 2. Update account level from TRIAL (0) to verified (1)
  const accountDevice = await AccountsRepository().findByUserId(userUpdated.id)
  if (accountDevice instanceof Error) return accountDevice
  accountDevice.level = AccountLevel.One
  const accountUpdated = await AccountsRepository().update(accountDevice)
  if (accountUpdated instanceof Error) return accountUpdated

  return accountUpdated
}
