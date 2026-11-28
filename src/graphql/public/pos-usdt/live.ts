import { flashLiveUpdates } from "@services/pos-usdt-checkout/live"

import { posUsdtLiveFields } from "./live-fields"

export const posUsdtLive = posUsdtLiveFields(flashLiveUpdates)
