import { GT } from "@graphql/index"

import FeaturedMerchant from "@graphql/public/types/object/featured-merchant"
import { mapError } from "@graphql/error-map"
import { FeaturedMerchants } from "@app"

const FlashFavoritesQuery = GT.Field({
  type: GT.NonNullList(FeaturedMerchant),
  resolve: async (): Promise<FeaturedMerchantRecord[] | { errors: IError[] }> => {
    const merchants = await FeaturedMerchants.getFeaturedMerchants()

    if (merchants instanceof Error) {
      throw mapError(merchants)
    }

    return merchants
  },
})

export default FlashFavoritesQuery
