import {
  BridgeConfig,
  Cashout,
  NETWORK,
  Topup,
  getFeesConfig,
  getGaloyBuildInformation,
  getLightningAddressDomain,
  getLightningAddressDomainAliases,
  getReferralRewardConfig,
} from "@config"

import { getSupportedCountries } from "@app/authentication/get-supported-countries"
import { GIFT_CARD_PROVIDER_IDS } from "@domain/gift-cards"

import { getFygaroSettings } from "@services/fygaro/webhook-server/fygaro-settings"
import { isGiftCardProviderEnabled } from "@services/gift-cards/registry"

import { GT } from "@graphql/index"
import Globals from "@graphql/public/types/object/globals"

const feesConfig = getFeesConfig()

const GlobalsQuery = GT.Field({
  type: Globals,
  resolve: async () => {
    // let nodesIds = await Lightning.listNodesPubkeys()
    // if (nodesIds instanceof Error) nodesIds = []

    // Fee params for the card-topup "you'll receive $X" preview. Sourced from
    // the cached Fygaro Settings; null when unavailable so the app degrades.
    const fygaroSettings = await getFygaroSettings()

    return {
      nodesIds: [],
      network: NETWORK,
      lightningAddressDomain: getLightningAddressDomain(),
      lightningAddressDomainAliases: getLightningAddressDomainAliases(),
      buildInformation: getGaloyBuildInformation(),
      supportedCountries: getSupportedCountries(),
      feesInformation: {
        deposit: {
          minBankFee: `${feesConfig.depositDefaultMin.amount}`,
          minBankFeeThreshold: `${feesConfig.depositThreshold.amount}`,
          ratio: `${feesConfig.depositRatioAsBasisPoints}`,
        },
      },
      topupEnabled: Topup.Enabled,
      cashoutEnabled: Cashout.Enabled,
      bridgeEnabled: BridgeConfig.enabled,
      referralRewardEnabled: getReferralRewardConfig().enabled,
      // The rail flag alone is not enough: with every provider off, every
      // gift-card field answers GIFT_CARD_PROVIDER_UNAVAILABLE, so the entry
      // point must stay hidden. `isGiftCardProviderEnabled` folds in the
      // master `giftCards.enabled` switch.
      giftCardsEnabled: GIFT_CARD_PROVIDER_IDS.some((id) =>
        isGiftCardProviderEnabled(id),
      ),
      fygaroTopup: fygaroSettings
        ? {
            minimumAmount: fygaroSettings.minimumTopup,
            processorFeePercent: fygaroSettings.processorFeePercent,
            processorFeeFixed: fygaroSettings.processorFeeFixed,
            flashFeePercent: fygaroSettings.flashMarginPercent,
            flashFeeFixed: fygaroSettings.flashMarginFixed,
            l1DailyLimit: fygaroSettings.dailyTopupLimits[1],
            l2DailyLimit: fygaroSettings.dailyTopupLimits[2],
            l3DailyLimit: fygaroSettings.dailyTopupLimits[3],
          }
        : null,
    }
  },
})

export default GlobalsQuery
