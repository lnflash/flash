import {
  getConsentLogAttemptLimits,
  getFailedLoginAttemptPerIpLimits,
  getFailedLoginAttemptPerLoginIdentifierLimits,
  getFygaroCheckoutCreateAttemptLimits,
  getFygaroTopupAllowanceAttemptLimits,
  getInviteCreateAttemptLimits,
  getInviteTargetAttemptLimits,
  getInvoiceCreateAttemptLimits,
  getInvoiceCreateForRecipientAttemptLimits,
  getOnChainAddressCreateAttemptLimits,
  getPaymentSendAttemptLimits,
  getPaymentSendDailyAttemptLimits,
  getRequestCodeBlockedCountryPerIpLimits,
  getRequestCodePerIpLimits,
  getRequestCodePerLoginIdentifierLimits,
} from "@config"

import {
  ConsentLogIpRateLimiterExceededError,
  FygaroCheckoutCreateRateLimiterExceededError,
  FygaroTopupAllowanceRateLimiterExceededError,
  InviteCreateRateLimiterExceededError,
  InviteTargetRateLimiterExceededError,
  InvoiceCreateForRecipientRateLimiterExceededError,
  InvoiceCreateRateLimiterExceededError,
  OnChainAddressCreateRateLimiterExceededError,
  PaymentSendRateLimiterExceededError,
  UserLoginIpRateLimiterExceededError,
  UserLoginIdentifierRateLimiterExceededError,
  UserCodeAttemptIpRateLimiterExceededError,
  UserCodeAttemptIdentifierRateLimiterExceededError,
  UserCodeAttemptBlockedCountryIpRateLimiterExceededError,
} from "./errors"

export const RateLimitPrefix = {
  requestCodeAttemptPerLoginIdentifier: "request_code_attempt_id",
  requestCodeAttemptPerIp: "request_code_attempt_ip",
  requestCodeBlockedCountryPerIp: "request_code_blocked_country_ip",
  failedLoginAttemptPerLoginIdentifier: "login_attempt_id",
  failedLoginAttemptPerIp: "login_attempt_ip",
  invoiceCreate: "invoice_create",
  invoiceCreateForRecipient: "invoice_create_for_recipient",
  onChainAddressCreate: "onchain_address_create",
  inviteCreate: "invite_daily",
  inviteTarget: "invite_target",
  fygaroCheckoutCreate: "fygaro_checkout_create",
  consentLog: "consent_log_ip",
  fygaroTopupAllowance: "fygaro_topup_allowance",
  paymentSend: "payment_send",
  paymentSendDaily: "payment_send_daily",
} as const

export const RateLimitConfig: { [key: string]: RateLimitConfig } = {
  requestCodeAttemptPerLoginIdentifier: {
    key: RateLimitPrefix.requestCodeAttemptPerLoginIdentifier,
    limits: getRequestCodePerLoginIdentifierLimits(),
    error: UserCodeAttemptIdentifierRateLimiterExceededError,
  },
  requestCodeAttemptPerIp: {
    key: RateLimitPrefix.requestCodeAttemptPerIp,
    limits: getRequestCodePerIpLimits(),
    error: UserCodeAttemptIpRateLimiterExceededError,
  },
  // Requests for a destination country we refuse to pay for. The existing-user
  // carve-out answers "does this number hold a Flash account" for free — no
  // provider spend, so none of the economics that bound every other
  // enumeration attempt apply. This bucket is what bounds it.
  requestCodeBlockedCountryPerIp: {
    key: RateLimitPrefix.requestCodeBlockedCountryPerIp,
    limits: getRequestCodeBlockedCountryPerIpLimits(),
    error: UserCodeAttemptBlockedCountryIpRateLimiterExceededError,
  },
  failedLoginAttemptPerLoginIdentifier: {
    key: RateLimitPrefix.failedLoginAttemptPerLoginIdentifier,
    limits: getFailedLoginAttemptPerLoginIdentifierLimits(),
    error: UserLoginIdentifierRateLimiterExceededError,
  },
  failedLoginAttemptPerIp: {
    key: RateLimitPrefix.failedLoginAttemptPerIp,
    limits: getFailedLoginAttemptPerIpLimits(),
    error: UserLoginIpRateLimiterExceededError,
  },
  invoiceCreate: {
    key: RateLimitPrefix.invoiceCreate,
    limits: getInvoiceCreateAttemptLimits(),
    error: InvoiceCreateRateLimiterExceededError,
  },
  invoiceCreateForRecipient: {
    key: RateLimitPrefix.invoiceCreateForRecipient,
    limits: getInvoiceCreateForRecipientAttemptLimits(),
    error: InvoiceCreateForRecipientRateLimiterExceededError,
  },
  onChainAddressCreate: {
    key: RateLimitPrefix.onChainAddressCreate,
    limits: getOnChainAddressCreateAttemptLimits(),
    error: OnChainAddressCreateRateLimiterExceededError,
  },
  inviteCreate: {
    key: RateLimitPrefix.inviteCreate,
    limits: getInviteCreateAttemptLimits(),
    error: InviteCreateRateLimiterExceededError,
  },
  inviteTarget: {
    key: RateLimitPrefix.inviteTarget,
    limits: getInviteTargetAttemptLimits(),
    error: InviteTargetRateLimiterExceededError,
  },
  // Same class of per-account resource-minting call as invoiceCreate and
  // onChainAddressCreate — except this one also runs an ERPNext list query per
  // call, against the exact read every other card top-up depends on.
  fygaroCheckoutCreate: {
    key: RateLimitPrefix.fygaroCheckoutCreate,
    limits: getFygaroCheckoutCreateAttemptLimits(),
    error: FygaroCheckoutCreateRateLimiterExceededError,
  },
  // The read side of the same ERPNext dependency, and the CHEAPER one to abuse:
  // no amount argument, so nothing can short-circuit before the trailing-24h
  // list query runs. Its own key so a customer who has spent the mutation's
  // budget can still be told what is left of their allowance.
  fygaroTopupAllowance: {
    key: RateLimitPrefix.fygaroTopupAllowance,
    limits: getFygaroTopupAllowanceAttemptLimits(),
    error: FygaroTopupAllowanceRateLimiterExceededError,
  },
  // ENG-573 send guard: two buckets on the same per-account key — a burst
  // bucket and a daily bucket. Both count *attempts*, rejected ones included,
  // so probing the amount space is bounded by the caller's own budget.
  paymentSend: {
    key: RateLimitPrefix.paymentSend,
    limits: getPaymentSendAttemptLimits(),
    error: PaymentSendRateLimiterExceededError,
  },
  paymentSendDaily: {
    key: RateLimitPrefix.paymentSendDaily,
    limits: getPaymentSendDailyAttemptLimits(),
    error: PaymentSendRateLimiterExceededError,
  },
  // Public, unauthenticated write endpoint (consent evidence from the
  // getflash.io/invite page). Per-IP: one legitimate submission per accept
  // click, so the ceiling is far above any real use and far below abuse.
  consentLog: {
    key: RateLimitPrefix.consentLog,
    limits: getConsentLogAttemptLimits(),
    error: ConsentLogIpRateLimiterExceededError,
  },
}
