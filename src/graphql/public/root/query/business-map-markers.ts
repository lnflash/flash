import { GT } from "@graphql/index"

import MapMarker from "@graphql/public/types/object/map-marker"
import { mapError } from "@graphql/error-map"
import { Merchants } from "@app"
import { AccountsRepository } from "@services/mongoose"

const BusinessMapMarkersQuery = GT.Field({
  type: GT.NonNullList(MapMarker),
  resolve: async (): Promise<BusinessMapMarkerLegacy[] | { errors: IError[] }> => {
    const merchants = await Merchants.getMerchantsMapMarkers()

    if (merchants instanceof Error) {
      throw mapError(merchants)
    }

    const accountsRepo = AccountsRepository()

    const markers = await Promise.all(
      merchants.map(async (merchant) => {
        let pubkey: string | null = null

        if (merchant.pubkey) {
          pubkey = merchant.pubkey
        } else {
          // Fall back to looking up account by username
          const account = await accountsRepo.findByUsername(merchant.username)
          if (!(account instanceof Error) && account.npub) {
            pubkey = account.npub
          }
        }

        return {
          username: merchant.username,
          mapInfo: {
            title: merchant.title,
            coordinates: {
              latitude: merchant.coordinates.latitude,
              longitude: merchant.coordinates.longitude,
            },
          },
          pubkey,
        }
      }),
    )

    return markers
  },
})

export default BusinessMapMarkersQuery
