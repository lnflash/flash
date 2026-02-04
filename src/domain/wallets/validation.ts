import { InvalidWalletId } from "@domain/errors"
import { ValidationError } from "@domain/shared/errors"

const UuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const WalletIdRegex = UuidRegex

export const checkedToWalletId = (walletId: string): WalletId | ValidationError => {
  if (!walletId.match(WalletIdRegex)) {
    return new InvalidWalletId(walletId)
  }
  return walletId as WalletId
}

export const isValidWalletId = (walletId: string): true | ValidationError => {
  const checkId = checkedToWalletId(walletId)
  if (checkId instanceof ValidationError) return checkId
  else return true
}