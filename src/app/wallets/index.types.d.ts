type AddInvoiceForSelfArgs = {
  walletId: WalletId
  amount: FractionalCentAmount // only supports USD for now
  memo?: string
  expiresIn: Minutes
}

type AddInvoiceForSelfForBtcWalletArgs = {
  walletId: string
  amount: BtcPaymentAmount
  memo?: string
  expiresIn?: number
}

type AddInvoiceForSelfForUsdWalletArgs = {
  walletId: string
  amount: FractionalCentAmount
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
  amount: FractionalCentAmount // only supports USD for now
  memo?: string
  descriptionHash?: string
  expiresIn: Minutes
}

type AddInvoiceForRecipientForBtcWalletArgs = {
  recipientWalletId: string
  amount: BtcPaymentAmount
  memo?: string
  descriptionHash?: string
  expiresIn?: number
}

type AddInvoiceForRecipientForUsdWalletArgs = {
  recipientWalletId: string
  amount: FractionalCentAmount
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

// ENG-573: the send guard, as the idempotency wrapper's `authorize` hook. A
// resolver hands this down instead of awaiting the guard itself, so a replayed
// idempotency key returns the cached result without spending attempt budget or
// being re-judged against a moved mid price. See @app/payments/idempotency.
type SendGuardHook = () => Promise<true | ApplicationError>

type PaymentSendArgs = {
  senderWalletId: WalletId
  senderAccount?: Account
  memo: string | null
  // Optional client-supplied idempotency key (ENG-530). When present, a repeated
  // send with the same key returns the original result instead of executing again.
  // Absent = unchanged behavior (existing/internal callers do not supply one).
  idempotencyKey?: string | null
}

type PayInvoiceByWalletIdArgs = PaymentSendArgs & {
  uncheckedPaymentRequest: string
  senderAccount: Account
}

type PayNoAmountInvoiceByWalletIdArgs = PaymentSendArgs & {
  uncheckedPaymentRequest: string
  amount: number
  senderAccount: Account
  // ENG-573 send guard, handed to `withPaymentIdempotency` as its `authorize`
  // hook so it runs only on the path that will actually pay. See
  // `SendGuardHook` above.
  authorize?: SendGuardHook
}

type IntraLedgerPaymentSendUsernameArgs = PaymentSendArgs & {
  recipientUsername: Username
  amount: Satoshis
}

type IntraLedgerPaymentSendWalletIdArgs = PaymentSendArgs & {
  recipientWalletId: WalletId
  amount: number
  // ENG-573 send guard, handed to `withPaymentIdempotency` as its `authorize`
  // hook so it runs only on the path that will actually pay. See
  // `SendGuardHook` above.
  authorize?: SendGuardHook
}

type PayOnChainByWalletIdResult = {
  status: PaymentSendStatus
  payoutId: PayoutId | undefined
}
