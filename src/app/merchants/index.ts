import { checkedToUsername } from "@domain/accounts"
import { CouldNotFindMerchantFromUsernameError } from "@domain/errors"
import { MerchantsRepository } from "@services/mongoose"

export * from "./suggest-merchant-map"
export * from "./delete-merchant-map"
export * from "./approve-merchant-map"

const merchants = MerchantsRepository()

export const getMerchantsMapMarkers = async (): Promise<
  BusinessMapMarker[] | RepositoryError
> => {
  return merchants.listForMap()
}

export const getMerchantsPendingApproval = async (): Promise<
  BusinessMapMarker[] | RepositoryError
> => {
  return merchants.listPendingApproval()
}

export const getMerchantsByUsername = async (
  username: string,
): Promise<BusinessMapMarker[] | ApplicationError> => {
  const usernameValidated = checkedToUsername(username)
  if (usernameValidated instanceof Error) {
    return usernameValidated
  }

  const result = await merchants.findByUsername(usernameValidated)

  if (result instanceof CouldNotFindMerchantFromUsernameError) {
    return []
  }

  return result
}
