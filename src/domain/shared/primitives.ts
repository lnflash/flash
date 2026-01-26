// TODO: think how to differentiate physical from synthetic USD

// Wallets only support USD right now
export const WalletCurrency = {
  Usd: "USD",
  Jmd: "JMD",
  Btc: "BTC",
  Usdt: "USDT",
} as const

export const ExchangeCurrencyUnit = {
  Usd: "USDCENT",
  Btc: "BTCSAT",
} as const
