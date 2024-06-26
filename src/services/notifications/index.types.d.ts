type NotificationsDataObject = {
  walletId: WalletId
  txNotificationType: NotificationType
  amount: bigint
  currency: WalletCurrency
  displayAmount: DisplayCurrencyMajorAmount | undefined
  displayCurrency: DisplayCurrency | undefined
  displayCurrencyPerSat?: number
  sats?: Satoshis
  cents?: UsdCents
  txHash?: OnChainTxHash
}
