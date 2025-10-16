import { GT } from "@graphql/index"
import IError from "../../../shared/types/abstract/error"

const BusinessAddressEnrichPayload = GT.Object({
  name: "BusinessAddressEnrichPayload",
  fields: () => ({
    formattedAddress: {
      type: GT.String,
      description: "The standardized/formatted address returned by Google Places API",
    },
    latitude: {
      type: GT.Float,
      description: "Geographic latitude coordinate",
    },
    longitude: {
      type: GT.Float,
      description: "Geographic longitude coordinate",
    },
    errors: {
      type: GT.NonNull(GT.List(GT.NonNull(IError))),
    },
  }),
})

export default BusinessAddressEnrichPayload
