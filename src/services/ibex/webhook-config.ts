import { IbexConfig } from "@config"

export const ibexWebhookPaths = {
  onReceive: {
    invoice: "/receive/invoice",
    lnurl: "/receive/lnurlp",
    zap: "/receive/zap",
    onchain: "/receive/onchain",
    cashout: "/receive/cashout",
  },
  onPay: {
    invoice: "/pay/invoice",
    lnurl: "/pay/lnurl/:username",
    verify: "/pay/lnurl/verify/:paymentHash",
    onchain: "/pay/onchain",
  },
  cryptoReceive: {
    cryptoReceive: "/crypto/receive",
  },
} as const

const endpoint = (path: string) => IbexConfig.webhook.uri + path

export const ibexWebhookEndpoints = {
  onReceive: {
    invoice: endpoint(ibexWebhookPaths.onReceive.invoice),
    lnurl: endpoint(ibexWebhookPaths.onReceive.lnurl),
    onchain: endpoint(ibexWebhookPaths.onReceive.onchain),
    cashout: endpoint(ibexWebhookPaths.onReceive.cashout),
    zap: endpoint(ibexWebhookPaths.onReceive.zap),
  },
  onPay: {
    invoice: endpoint(ibexWebhookPaths.onPay.invoice),
    lnurl: endpoint(ibexWebhookPaths.onPay.lnurl),
    verify: endpoint(ibexWebhookPaths.onPay.verify),
    onchain: endpoint(ibexWebhookPaths.onPay.onchain),
  },
  cryptoReceive: {
    cryptoReceive: endpoint(ibexWebhookPaths.cryptoReceive.cryptoReceive),
  },
} as const

export const ibexWebhookSecret = IbexConfig.webhook.secret
