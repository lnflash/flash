// FIP-07: deny-by-default scope enforcement for API-key-authenticated requests.
//
// Every authed root field in the public schema must appear here, mapped to the
// ApiKeyScope it requires or to "BLOCKED" (session-only — never callable with an
// API key). A field missing from this map is treated as BLOCKED by the shield
// rule, and the completeness unit test fails so the omission is caught in CI.

export const API_KEY_FIELD_BLOCKED = "BLOCKED" as const

export type ApiKeyFieldAccess = ApiKeyScope | typeof API_KEY_FIELD_BLOCKED

export const apiKeyScopeForField: Readonly<Record<string, ApiKeyFieldAccess>> =
  Object.freeze({
    // ── Queries ────────────────────────────────────────────────────────────
    me: "read:user",
    transactionDetails: "read:transactions",
    latestAccountUpgradeRequest: "BLOCKED",
    bridgeKycStatus: "BLOCKED",
    bridgeVirtualAccount: "BLOCKED",
    bridgeExternalAccounts: "BLOCKED",
    bridgeWithdrawalRequest: "BLOCKED",
    bridgeWithdrawals: "BLOCKED",
    apiKeys: "BLOCKED",
    onChainTxFee: "read:wallet",
    onChainUsdTxFee: "read:wallet",
    onChainUsdTxFeeAsBtcDenominated: "read:wallet",

    // ── Mutations: session-only (auth/identity/KYC/cashout/key management) ─
    userLoginUpgrade: "BLOCKED",
    userEmailRegistrationInitiate: "BLOCKED",
    userEmailRegistrationValidate: "BLOCKED",
    userEmailDelete: "BLOCKED",
    userPhoneRegistrationInitiate: "BLOCKED",
    userPhoneRegistrationValidate: "BLOCKED",
    userPhoneDelete: "BLOCKED",
    userTotpRegistrationInitiate: "BLOCKED",
    userTotpRegistrationValidate: "BLOCKED",
    userTotpDelete: "BLOCKED",
    userQuizQuestionUpdateCompleted: "BLOCKED",
    quizCompleted: "BLOCKED",
    deviceNotificationTokenCreate: "BLOCKED",
    businessAccountUpgradeRequest: "BLOCKED",
    bankAccountUpdateRequest: "BLOCKED",
    accountDelete: "BLOCKED",
    feedbackSubmit: "BLOCKED",
    idDocumentUploadUrlGenerate: "BLOCKED",
    updateExternalWallet: "BLOCKED",
    bridgeInitiateKyc: "BLOCKED",
    bridgeCreateVirtualAccount: "BLOCKED",
    bridgeAddExternalAccount: "BLOCKED",
    bridgeCreateExternalAccount: "BLOCKED",
    bridgeSetDefaultExternalAccount: "BLOCKED",
    bridgeDeleteExternalAccount: "BLOCKED",
    bridgeRequestWithdrawal: "BLOCKED",
    bridgeInitiateWithdrawal: "BLOCKED",
    bridgeCancelWithdrawalRequest: "BLOCKED",
    requestCashout: "BLOCKED",
    initiateCashout: "BLOCKED",
    apiKeyCreate: "BLOCKED",
    apiKeyRevoke: "BLOCKED",
    apiKeyRotate: "BLOCKED",

    // ── Mutations: write:user ──────────────────────────────────────────────
    userUpdateLanguage: "write:user",
    userUpdateUsername: "write:user",
    userUpdateNpub: "write:user",
    userContactUpdateAlias: "write:user",
    accountUpdateDefaultWalletId: "write:user",
    accountUpdateDisplayCurrency: "write:user",
    accountEnableNotificationCategory: "write:user",
    accountDisableNotificationCategory: "write:user",
    accountEnableNotificationChannel: "write:user",
    accountDisableNotificationChannel: "write:user",

    // ── Mutations: admin ───────────────────────────────────────────────────
    callbackEndpointAdd: "admin",
    callbackEndpointDelete: "admin",

    // ── Mutations: read:wallet (read-only fee probes) ──────────────────────
    lnInvoiceFeeProbe: "read:wallet",
    lnUsdInvoiceFeeProbe: "read:wallet",
    lnNoAmountInvoiceFeeProbe: "read:wallet",
    lnNoAmountUsdInvoiceFeeProbe: "read:wallet",

    // ── Mutations: write:wallet ────────────────────────────────────────────
    intraLedgerPaymentSend: "write:wallet",
    intraLedgerUsdPaymentSend: "write:wallet",
    lnInvoiceCreate: "write:wallet",
    lnUsdInvoiceCreate: "write:wallet",
    lnNoAmountInvoiceCreate: "write:wallet",
    lnInvoicePaymentSend: "write:wallet",
    lnNoAmountInvoicePaymentSend: "write:wallet",
    lnNoAmountUsdInvoicePaymentSend: "write:wallet",
    lnurlPaymentSend: "write:wallet",
    onChainAddressCreate: "write:wallet",
    onChainAddressCurrent: "write:wallet",
    onChainPaymentSend: "write:wallet",
    onChainUsdPaymentSend: "write:wallet",
    onChainUsdPaymentSendAsBtcDenominated: "write:wallet",
    onChainPaymentSendAll: "write:wallet",
  })

// Nested-field guards: a root field like `me` only requires read:user, but the
// wallet/transaction data reachable through its object graph must each require
// its own scope so a read:user key can't escalate to balances or transaction
// history. Keyed by GraphQL type name → field → required scope. The completeness
// test asserts every sensitive field on these types is listed here.
export const apiKeyNestedFieldScopes: Record<
  string,
  Record<string, ApiKeyScope>
> = Object.freeze({
  ConsumerAccount: {
    wallets: "read:wallet",
    transactions: "read:transactions",
    csvTransactions: "read:transactions",
  },
  UserContact: {
    transactions: "read:transactions",
    transactionsCount: "read:transactions",
  },
  BTCWallet: {
    balance: "read:wallet",
    pendingIncomingBalance: "read:wallet",
    transactions: "read:transactions",
    transactionsByAddress: "read:transactions",
  },
  UsdWallet: {
    balance: "read:wallet",
    pendingIncomingBalance: "read:wallet",
    transactions: "read:transactions",
    transactionsByAddress: "read:transactions",
  },
  UsdtWallet: {
    balance: "read:wallet",
    pendingIncomingBalance: "read:wallet",
    transactions: "read:transactions",
    transactionsByAddress: "read:transactions",
  },
})

// admin grants every non-BLOCKED scope; write:X implies read:X.
// BLOCKED fields never reach this check — they are rejected outright.
export const hasApiKeyScope = ({
  grantedScopes,
  required,
}: {
  grantedScopes: string[]
  required: ApiKeyScope
}): boolean => {
  if (grantedScopes.includes("admin")) return true
  if (grantedScopes.includes(required)) return true
  if (required.startsWith("read:")) {
    const writeEquivalent = `write:${required.slice("read:".length)}`
    if (grantedScopes.includes(writeEquivalent)) return true
  }
  return false
}
