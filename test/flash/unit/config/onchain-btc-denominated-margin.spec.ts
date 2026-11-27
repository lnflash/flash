import Ajv from "ajv"

import {
  DEFAULT_BTC_DENOMINATED_SEND_MARGIN_BPS,
  getOnChainBtcDenominatedSendMarginBps,
} from "@config"

import { configSchema } from "../../../../src/config/schema"

// The margin added when a Cash wallet pays a sat-denominated on-chain request
// (src/app/payments/usd-cents-for-sats.ts). A wrong value here is money: too
// low and a bill arrives short, too high and every payer overpays.
describe("onChainWallet.btcDenominatedSendMarginBps", () => {
  const onChainWallet = configSchema.properties.onChainWallet
  const compile = () =>
    new Ajv({ useDefaults: true }).compile({
      type: "object",
      properties: { onChainWallet },
    })
  const block = (extra: Record<string, unknown> = {}) => ({
    onChainWallet: {
      dustThreshold: 5000,
      minConfirmations: 2,
      scanDepth: 360,
      scanDepthOutgoing: 2,
      scanDepthChannelUpdate: 8,
      ...extra,
    },
  })

  it("ships at half a percent", () => {
    expect(DEFAULT_BTC_DENOMINATED_SEND_MARGIN_BPS).toBe(50)
    expect(getOnChainBtcDenominatedSendMarginBps()).toBe(50)
    expect(onChainWallet.properties.btcDenominatedSendMarginBps.default).toBe(50)
  })

  it("is filled in when a deployment sets the block without the key", () => {
    const config = block()
    expect(compile()(config)).toBe(true)
    expect(config.onChainWallet).toMatchObject({ btcDenominatedSendMarginBps: 50 })
  })

  it("is not required, so an older deployment yaml still validates", () => {
    expect(onChainWallet.required).not.toContain("btcDenominatedSendMarginBps")
  })

  it.each([0, 1, 50, 1000])("accepts %p basis points", (bps) => {
    expect(compile()(block({ btcDenominatedSendMarginBps: bps }))).toBe(true)
  })

  it.each([-1, 1001, 0.5, "50"])("rejects %p at boot", (bps) => {
    expect(compile()(block({ btcDenominatedSendMarginBps: bps }))).toBe(false)
  })
})
