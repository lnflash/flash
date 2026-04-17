import { GT } from "@graphql/index"

import MapMarker from "@graphql/public/types/object/map-marker"
import { mapError } from "@graphql/error-map"
import { Merchants } from "@app"

const ClosestMerchantsQuery = GT.Field({
  type: GT.NonNullList(MapMarker),
  args: {
    latitude: { type: GT.NonNull(GT.Float) },
    longitude: { type: GT.NonNull(GT.Float) },
  },
  resolve: async (
    _,
    args,
  ): Promise<BusinessMapMarkerLegacy[] | { errors: IError[] }> => {
    const { latitude, longitude } = args

    if (latitude instanceof Error) throw latitude
    if (longitude instanceof Error) throw longitude

    const merchants = await Merchants.getClosestMerchants({
      latitude,
      longitude,
    })

    if (merchants instanceof Error) {
      throw mapError(merchants)
    }

    return merchants.map((merchant) => ({
      username: merchant.username,
      mapInfo: {
        title: merchant.title,
        coordinates: {
          latitude: merchant.coordinates.latitude,
          longitude: merchant.coordinates.longitude,
        },
      },
    }))
  },
})

export default ClosestMerchantsQuery
