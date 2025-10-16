import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BusinessAddressEnrichPayload from "@graphql/public/types/payload/business-address-enrich-payload"
import { businessAddressEnrich } from "@app/geocoding"

/**
 * Query to enrich business addresses using Google Places API
 *
 * Takes a raw address string and returns formatted address with coordinates.
 * Results are cached for 7 days to minimize API costs.
 */
const BusinessAddressEnrichQuery = GT.Field({
  type: GT.NonNull(BusinessAddressEnrichPayload),
  args: {
    address: {
      type: GT.NonNull(GT.String),
      description: "The raw address string to enrich (minimum 3 characters)",
    },
  },
  resolve: async (_, args) => {
    const { address } = args

    const result = await businessAddressEnrich(address)

    if (result instanceof Error) {
      return {
        formattedAddress: null,
        latitude: null,
        longitude: null,
        errors: [mapAndParseErrorForGqlResponse(result)],
      }
    }

    return {
      formattedAddress: result.formattedAddress,
      latitude: result.latitude,
      longitude: result.longitude,
      errors: [],
    }
  },
})

export default BusinessAddressEnrichQuery
