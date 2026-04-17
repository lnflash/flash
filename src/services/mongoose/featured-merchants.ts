import { FeaturedMerchant } from "./schema"
import { parseRepositoryError } from "./utils"

interface IFeaturedMerchantRepository {
  list(): Promise<FeaturedMerchantRecord[] | RepositoryError>
  create(args: {
    merchantUsername: string
    title: string
    description?: string
    priority?: number
  }): Promise<FeaturedMerchantRecord | RepositoryError>
  update(args: {
    id: string
    title?: string
    description?: string
    priority?: number
    active?: boolean
  }): Promise<FeaturedMerchantRecord | RepositoryError>
  remove(id: string): Promise<void | RepositoryError>
}

export const FeaturedMerchantsRepository = (): IFeaturedMerchantRepository => {
  const list = async (): Promise<FeaturedMerchantRecord[] | RepositoryError> => {
    try {
      return await FeaturedMerchant.find({ active: true }).sort({
        priority: -1,
        createdAt: -1,
      })
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const create = async ({
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
    try {
      return await FeaturedMerchant.create({
        merchantUsername,
        title,
        description: description ?? "",
        priority: priority ?? 0,
        active: true,
      })
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const update = async ({
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
    try {
      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (title !== undefined) updates.title = title
      if (description !== undefined) updates.description = description
      if (priority !== undefined) updates.priority = priority
      if (active !== undefined) updates.active = active

      const result = await FeaturedMerchant.findOneAndUpdate({ id }, updates, {
        new: true,
      })
      if (!result) {
        return new Error("Featured merchant not found")
      }
      return result
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const remove = async (id: string): Promise<void | RepositoryError> => {
    try {
      await FeaturedMerchant.deleteOne({ id })
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  return {
    list,
    create,
    update,
    remove,
  }
}
