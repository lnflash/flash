import { FeaturedMerchantsRepository } from "@services/mongoose"

const featuredMerchants = FeaturedMerchantsRepository()

export const getFeaturedMerchants = async (): Promise<
  FeaturedMerchantRecord[] | RepositoryError
> => {
  return featuredMerchants.list()
}

export const addFeaturedMerchant = async ({
  merchantUsername,
  title,
  description,
  priority,
}: {
  merchantUsername: string
  title: string
  description?: string
  priority?: number
}): Promise<FeaturedMerchantRecord | RepositoryError> => {
  return featuredMerchants.create({
    merchantUsername,
    title,
    description,
    priority,
  })
}

export const updateFeaturedMerchant = async ({
  id,
  title,
  description,
  priority,
  active,
}: {
  id: string
  title?: string
  description?: string
  priority?: number
  active?: boolean
}): Promise<FeaturedMerchantRecord | RepositoryError> => {
  return featuredMerchants.update({ id, title, description, priority, active })
}

export const removeFeaturedMerchant = async (
  id: string,
): Promise<void | RepositoryError> => {
  return featuredMerchants.remove(id)
}
