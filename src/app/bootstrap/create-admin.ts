import { randomUUID } from "crypto"
import { createAccountWithPhoneIdentifier } from "@app/accounts"

import { getDefaultAccountsConfig } from "@config"

import { CouldNotFindAccountFromKratosIdError, CouldNotFindError } from "@domain/errors"
import { WalletCurrency } from "@domain/shared"

import {
  AccountsRepository,
  UsersRepository,
  WalletsRepository,
} from "@services/mongoose"
import { Account } from "@services/mongoose/schema"
import { toObjectId } from "@services/mongoose/utils"

export const randomUserId = () => randomUUID() as UserId

export const createAdmin = async (admin: AdminAccount): Promise<void | Error> => {
    const kratosUserId = await findOrCreateUser(admin.phone)
    if (kratosUserId instanceof Error) throw kratosUserId

    const account = await findOrCreateAccount(kratosUserId, admin)
    if (account instanceof Error) throw account

    const wallet = validateWallet(account)
    if (wallet instanceof Error) throw wallet
}

const findOrCreateUser = async (phone: PhoneNumber): Promise<UserId | Error> => {
    const user = await UsersRepository().findByPhone(phone)
    
    if (user instanceof CouldNotFindError) {
      const randomKratosUserId = randomUserId()

      const res = await UsersRepository().update({
        id: randomKratosUserId,
        deviceTokens: [`token-${randomKratosUserId}`] as DeviceToken[],
        phone,
      })
      
      if (res instanceof Error) return res
      else return randomKratosUserId
    } else {
      if (user instanceof Error) return user
      else return user.id
    }
}

const findOrCreateAccount = async (kratosUserId: UserId, admin: AdminAccount): Promise<Account | Error> => {
  const { phone, role } = admin
  let account = await AccountsRepository().findByUserId(kratosUserId)
  if (account instanceof CouldNotFindAccountFromKratosIdError) {
    account = await createAccountWithPhoneIdentifier({
      newAccountInfo: { phone, kratosUserId },
      config: getDefaultAccountsConfig(),
    })
  }
  if (account instanceof Error) return account

  // TODO: move this to createAccount 
  await Account.findOneAndUpdate(
    { _id: toObjectId<AccountId>(account.id) },
    { role, contactEnabled: false }
  )

  return account

}

const validateWallet = async (account: Account): Promise<void | Error> => {
  const wallet = await WalletsRepository().findById(account.defaultWalletId)
  if (wallet instanceof Error) return wallet
  if (wallet.currency !== WalletCurrency.Usd) {
    return new Error("Expected USD-currency default wallet")
  }
}