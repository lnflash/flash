import {
  getFailedLoginAttemptPerIpLimits,
  getFailedLoginAttemptPerLoginIdentifierLimits,
  getFygaroCheckoutCreateAttemptLimits,
  getInviteCreateAttemptLimits,
  getInviteTargetAttemptLimits,
  getInvoiceCreateAttemptLimits,
  getInvoiceCreateForRecipientAttemptLimits,
  getOnChainAddressCreateAttemptLimits,
  getRequestCodePerIpLimits,
  getRequestCodePerLoginIdentifierLimits,
} from "@config"

import {
  FygaroCheckoutCreateRateLimiterExceededError,
  InviteCreateRateLimiterExceededError,
  InviteTargetRateLimiterExceededError,
  InvoiceCreateForRecipientRateLimiterExceededError,
  InvoiceCreateRateLimiterExceededError,
  OnChainAddressCreateRateLimiterExceededError,
  UserLoginIpRateLimiterExceededError,
  UserLoginIdentifierRateLimiterExceededError,
  UserCodeAttemptIpRateLimiterExceededError,
  UserCodeAttemptIdentifierRateLimiterExceededError,
} from "./errors"

export const RateLimitPrefix = {
  requestCodeAttemptPerLoginIdentifier: "request_code_attempt_id",
  requestCodeAttemptPerIp: "request_code_attempt_ip",
  failedLoginAttemptPerLoginIdentifier: "login_attempt_id",
  failedLoginAttemptPerIp: "login_attempt_ip",
  invoiceCreate: "invoice_create",
  invoiceCreateForRecipient: "invoice_create_for_recipient",
  onChainAddressCreate: "onchain_address_create",
  inviteCreate: "invite_daily",
  inviteTarget: "invite_target",
  fygaroCheckoutCreate: "fygaro_checkout_create",
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
}
