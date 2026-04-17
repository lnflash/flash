import { GT } from "@graphql/index"

const FeaturedMerchant = GT.Object({
  name: "FeaturedMerchant",
  fields: () => ({
    id: {
      type: GT.NonNullID,
    },
    merchantUsername: {
      type: GT.NonNull(GT.String),
    },
    title: {
      type: GT.NonNull(GT.String),
    },
    description: {
      type: GT.String,
    },
    priority: {
      type: GT.NonNull(GT.Int),
    },
    active: {
      type: GT.NonNull(GT.Boolean),
    },
  }),
})

export default FeaturedMerchant
