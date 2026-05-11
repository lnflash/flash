type AddInvoiceForSelfArgs = {
  walletId: WalletId
  amount: number | FractionalCentAmount // only supports USD for now
  memo?: string
  expiresIn: Minutes
}

type AddInvoiceForSelfForBtcWalletArgs = {
  walletId: string
  amount: number
  memo?: string
  expiresIn?: number
}

type AddInvoiceForSelfForUsdWalletArgs = {
  walletId: string
  amount: number | FractionalCentAmount
  memo?: string
  expiresIn?: number
}

type AddInvoiceNoAmountForSelfArgs = {
  walletId: string
  memo?: string
  expiresIn?: number
}

type AddInvoiceForRecipientArgs = {
  recipientWalletId: WalletId
  amount: number | FractionalCentAmount // only supports USD for now
  memo?: string
  descriptionHash?: string
  expiresIn: Minutes
}

type AddInvoiceForRecipientForBtcWalletArgs = {
  recipientWalletId: string
  amount: number
  memo?: string
  descriptionHash?: string
  expiresIn?: number
}

type AddInvoiceForRecipientForUsdWalletArgs = {
  recipientWalletId: string
  amount: number | FractionalCentAmount
  memo?: string
  descriptionHash?: string
  expiresIn?: number
}

type AddInvoiceNoAmountForRecipientArgs = {
  recipientWalletId: string
  memo?: string
  expiresIn?: number
}

type BuildWIBWithAmountFnArgs = {
  walletInvoiceBuilder: WalletInvoiceBuilder
  recipientWalletDescriptor: WalletDescriptor<WalletCurrency>
}

type AddInvoiceArgs = {
  walletId: WalletId
  limitCheckFn: (accountId: AccountId) => Promise<true | RateLimitServiceError>
  buildWIBWithAmountFn: (
    buildWIBWithAmountFnArgs: BuildWIBWithAmountFnArgs,
  ) => Promise<ValidationError | DealerPriceServiceError | WIBWithAmount>
}

type GetOnChainFeeWithoutCurrencyArgs = {
  walletId: WalletId
  account: Account
  amount: number
  address: string | OnChainAddress
  speed: PayoutSpeed
}

type GetOnChainFeeArgs = GetOnChainFeeWithoutCurrencyArgs & {
  amountCurrency: WalletCurrency
}

type PaymentSendArgs = {
  senderWalletId: WalletId
  senderAccount?: Account
  memo: string | null
}

type PayInvoiceByWalletIdArgs = PaymentSendArgs & {
  uncheckedPaymentRequest: string
  senderAccount: Account
}

type PayNoAmountInvoiceByWalletIdArgs = PaymentSendArgs & {
  uncheckedPaymentRequest: string
  amount: number
  senderAccount: Account
}

type IntraLedgerPaymentSendUsernameArgs = PaymentSendArgs & {
  recipientUsername: Username
  amount: Satoshis
}

type IntraLedgerPaymentSendWalletIdArgs = PaymentSendArgs & {
  recipientWalletId: WalletId
  amount: number
}

type PayOnChainByWalletIdResult = {
  status: PaymentSendStatus
  payoutId: PayoutId | undefined
}
