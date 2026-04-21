import util from "util"

import { credentials } from "@grpc/grpc-js"
import {
  PriceServiceError,
  UnknownPriceServiceError,
  PriceNotAvailableError,
  PriceCurrenciesNotAvailableError,
} from "@domain/price"

import { SATS_PER_BTC } from "@domain/bitcoin"

import { WalletCurrency } from "@domain/shared"

import { CENTS_PER_USD, UsdDisplayCurrency } from "@domain/fiat"

import { PRICE_HISTORY_HOST, PRICE_HISTORY_PORT, PRICE_HOST, PRICE_PORT } from "@config"

import { baseLogger } from "../logger"

import { PriceHistoryProtoDescriptor, PriceProtoDescriptor } from "./grpc"

const priceUrl = PRICE_HOST
const pricePort = PRICE_PORT
const fullUrl = `${priceUrl}:${pricePort}`
const priceClient = new PriceProtoDescriptor.PriceFeed(
  fullUrl,
  credentials.createInsecure(),
)
const getPrice = util.promisify(priceClient.getPrice).bind(priceClient)
const listPriceCurrencies = util.promisify(priceClient.listCurrencies).bind(priceClient)

const priceHistoryUrl = PRICE_HISTORY_HOST
const priceHistoryPort = PRICE_HISTORY_PORT
const priceHistoryFullUrl = `${priceHistoryUrl}:${priceHistoryPort}`
const priceHistoryClient = new PriceHistoryProtoDescriptor.PriceHistory(
  priceHistoryFullUrl,
  credentials.createInsecure(),
)
const listPrices = util.promisify(priceHistoryClient.listPrices).bind(priceHistoryClient)

/**
 * ENG-317 / Phase A of the float→double rollout for the price wire format.
 *
 * The wire now carries two fields: `price` (float32, deprecated, original tag)
 * and `price_v2` (double, new tag). Servers populate both during Phase A;
 * older servers populate only `price`. We prefer `price_v2` and fall back to
 * `price` so this client works against both server versions.
 *
 * `@grpc/proto-loader` is configured with `defaults: true`, which means
 * unset scalar fields arrive as their proto3 default (`0` for floating-point
 * types). A real-time price of `0` is already treated as "no price" by the
 * `PriceNotAvailableError` path, so a falsy check is the correct fallback
 * trigger.
 *
 * Phase B (separate PR, after Phase A is in prod for one release cycle) will
 * remove the deprecated `price` field entirely.
 */
const preferDouble = (resp: { price?: number; price_v2?: number }): number =>
  resp.price_v2 || resp.price || 0

export const PriceService = (): IPriceService => {
  const getSatRealTimePrice = ({
    displayCurrency,
  }: GetSatRealTimePriceArgs): Promise<
    RealTimePrice<DisplayCurrency> | PriceServiceError
  > =>
    getRealTimePrice({
      displayCurrency,
      walletCurrency: WalletCurrency.Btc,
    })

  const getUsdCentRealTimePrice = ({
    displayCurrency,
  }: GetUsdCentRealTimePriceArgs): Promise<
    RealTimePrice<DisplayCurrency> | PriceServiceError
  > =>
    getRealTimePrice({
      displayCurrency,
      walletCurrency: WalletCurrency.Usd,
    })

  const getRealTimePrice = async ({
    displayCurrency,
    walletCurrency = WalletCurrency.Btc,
  }: GetRealTimePriceArgs): Promise<
    RealTimePrice<DisplayCurrency> | PriceServiceError
  > => {
    try {
      if (walletCurrency === displayCurrency) {
        const offset =
          displayCurrency === UsdDisplayCurrency ? CENTS_PER_USD : SATS_PER_BTC
        return {
          timestamp: new Date(),
          price: 1 / offset,
          currency: displayCurrency,
        }
      }

      // FIXME: price server should return CentsPerSat directly and timestamp
      const priceResponse = await getPrice({ currency: displayCurrency })
      const price = preferDouble(priceResponse)
      if (!price) return new PriceNotAvailableError()

      let displayCurrencyPrice = price / SATS_PER_BTC
      if (walletCurrency === WalletCurrency.Usd) {
        const usdPriceResponse = await getPrice({ currency: UsdDisplayCurrency })
        const usdBtcPrice = preferDouble(usdPriceResponse)
        if (!usdBtcPrice) return new PriceNotAvailableError()

        displayCurrencyPrice = price / usdBtcPrice / CENTS_PER_USD
      }

      return {
        timestamp: new Date(),
        price: displayCurrencyPrice,
        currency: displayCurrency,
      }
    } catch (err) {
      baseLogger.error({ err }, "impossible to fetch most recent price")
      return new UnknownPriceServiceError(err)
    }
  }

  const listHistory = async ({
    range,
  }: ListHistoryArgs): Promise<Tick[] | PriceServiceError> => {
    try {
      const { priceHistory } = await listPrices({ range })
      return priceHistory.map(
        (t: { timestamp: number; price?: number; price_v2?: number }) => ({
          date: new Date(t.timestamp * 1000),
          price: preferDouble(t) / SATS_PER_BTC,
        }),
      )
    } catch (err) {
      return new UnknownPriceServiceError(err)
    }
  }

  const listCurrencies = async (): Promise<PriceCurrency[] | PriceServiceError> => {
    try {
      const { currencies } = await listPriceCurrencies({})
      if (!currencies || currencies.length === 0)
        return new PriceCurrenciesNotAvailableError()

      return currencies.map(
        (c: {
          code: string
          symbol: string
          name: string
          flag: string
          fractionDigits: number
        }) =>
          ({
            code: c.code,
            symbol: c.symbol,
            name: c.name,
            flag: c.flag,
            fractionDigits: c.fractionDigits,
          }) as PriceCurrency,
      )
    } catch (err) {
      return new UnknownPriceServiceError(err)
    }
  }

  return {
    getSatRealTimePrice,
    getUsdCentRealTimePrice,
    listHistory,
    listCurrencies,
  }
}
