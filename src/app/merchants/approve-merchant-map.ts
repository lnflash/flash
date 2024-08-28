import { MerchantsRepository } from "@services/mongoose"

export const approveMerchantById = async (
  id: MerchantId,
): Promise<BusinessMapMarker | ApplicationError> => {
  const merchantsRepo = MerchantsRepository()

  const updatedMerchant = await merchantsRepo.findOneAndUpdate({
    id,
    updates: { validated: true },
  })

  return updatedMerchant
}
