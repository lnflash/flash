import { FeaturedMerchants } from "@app"

import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import FeaturedMerchant from "@graphql/public/types/object/featured-merchant"

const FeaturedMerchantInput = GT.Input({
  name: "FeaturedMerchantInput",
  fields: () => ({
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
      type: GT.Int,
    },
  }),
})

const UpdateFeaturedMerchantInput = GT.Input({
  name: "UpdateFeaturedMerchantInput",
  fields: () => ({
    id: {
      type: GT.NonNullID,
    },
    title: {
      type: GT.String,
    },
    description: {
      type: GT.String,
    },
    priority: {
      type: GT.Int,
    },
    active: {
      type: GT.Boolean,
    },
  }),
})

const FeaturedMerchantPayload = GT.Object({
  name: "FeaturedMerchantPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(GT.NonNullError),
    },
    featuredMerchant: {
      type: FeaturedMerchant,
    },
  }),
})

const AddFlashFavoriteMutation = GT.Field<null, GraphQLPublicContext>({
  type: GT.NonNull(FeaturedMerchantPayload),
  args: {
    input: { type: GT.NonNull(FeaturedMerchantInput) },
  },
  resolve: async (_, args) => {
    const { merchantUsername, title, description, priority } = args.input

    for (const input of [merchantUsername, title]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    const merchant = await FeaturedMerchants.addFeaturedMerchant({
      merchantUsername,
      title,
      description: description instanceof Error ? undefined : description ?? undefined,
      priority: priority instanceof Error ? undefined : priority ?? undefined,
    })

    if (merchant instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(merchant)] }
    }

    return {
      errors: [],
      featuredMerchant: merchant,
    }
  },
})

const UpdateFlashFavoriteMutation = GT.Field<null, GraphQLPublicContext>({
  type: GT.NonNull(FeaturedMerchantPayload),
  args: {
    input: { type: GT.NonNull(UpdateFeaturedMerchantInput) },
  },
  resolve: async (_, args) => {
    const { id, title, description, priority, active } = args.input

    if (id instanceof Error) {
      return { errors: [{ message: id.message }] }
    }

    const merchant = await FeaturedMerchants.updateFeaturedMerchant({
      id,
      title: title instanceof Error ? undefined : title ?? undefined,
      description: description instanceof Error ? undefined : description ?? undefined,
      priority: priority instanceof Error ? undefined : priority ?? undefined,
      active: active instanceof Error ? undefined : active ?? undefined,
    })

    if (merchant instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(merchant)] }
    }

    return {
      errors: [],
      featuredMerchant: merchant,
    }
  },
})

const RemoveFlashFavoriteMutation = GT.Field<null, GraphQLPublicContext>({
  type: GT.NonNull(FeaturedMerchantPayload),
  args: {
    id: { type: GT.NonNullID },
  },
  resolve: async (_, args) => {
    const { id } = args

    if (id instanceof Error) {
      return { errors: [{ message: id.message }] }
    }

    const result = await FeaturedMerchants.removeFeaturedMerchant(id)

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return {
      errors: [],
      featuredMerchant: null,
    }
  },
})

export { AddFlashFavoriteMutation, UpdateFlashFavoriteMutation, RemoveFlashFavoriteMutation }
