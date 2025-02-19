import { InactiveAccountError, InvalidWalletId } from "@domain/errors"

import { AccountStatus } from "./primitives"
import { ValidationError } from "@domain/shared"

export const AccountValidator = (
  account: Account,
): AccountValidator => {

  const isActive = (): true | ValidationError => {
    if (account.status !== AccountStatus.Active) {
      return new InactiveAccountError(account.id)
    }
    return true
  }

  const validateWalletForAccount = <S extends WalletCurrency>(
    wallet: WalletDescriptor<S>,
  ): true | ValidationError => {
    if (wallet.accountId !== account.id)
      return new InvalidWalletId(
        JSON.stringify({ accountId: account.id, accountIdFromWallet: wallet.accountId }),
      )

    return true
  }

  const isLevel = (minLevel: AccountLevel): true | ValidationError => {
    if (account.level >= minLevel) return true
    else return new ValidationError(`Account must be at least level ${minLevel}`)
  }

  return { validateWalletForAccount, isLevel, isActive }
}
