/**
 * SMART_ROUTER: Error Types and Classes
 *
 * Purpose: Define comprehensive error handling for Smart Router operations.
 * All errors include security context and recovery information.
 *
 * Security: Errors must not leak sensitive information while providing
 * enough detail for debugging and recovery.
 *
 * Dependencies:
 * - Domain error base classes
 *
 * @since smart-router-v1
 * @security-review pending
 * @milestone 1
 */

import { DomainError } from "@domain/shared"

/**
 * SMART_ROUTER: Error Code Enum
 *
 * Purpose: Standardized error codes for Smart Router operations
 *
 * Security: Error codes help with security monitoring and incident response
 *
 * @since smart-router-v1
 */
export enum SmartRouterErrorCode {
  // Adapter Errors
  ADAPTER_NOT_FOUND = "ADAPTER_NOT_FOUND",
  ADAPTER_UNAVAILABLE = "ADAPTER_UNAVAILABLE",
  ADAPTER_AUTHENTICATION_FAILED = "ADAPTER_AUTHENTICATION_FAILED",
  ADAPTER_INSUFFICIENT_BALANCE = "ADAPTER_INSUFFICIENT_BALANCE",

  // Routing Errors
  NO_ROUTE_FOUND = "NO_ROUTE_FOUND",
  ROUTE_EXECUTION_FAILED = "ROUTE_EXECUTION_FAILED",
  INVALID_ROUTE = "INVALID_ROUTE",

  // Token/Cashu Errors
  INVALID_TOKEN = "INVALID_TOKEN",
  TOKEN_ALREADY_SPENT = "TOKEN_ALREADY_SPENT",
  MINT_UNAVAILABLE = "MINT_UNAVAILABLE",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",

  // Vault Errors
  VAULT_LOCKED = "VAULT_LOCKED",
  VAULT_CORRUPTION = "VAULT_CORRUPTION",
  ENCRYPTION_FAILED = "ENCRYPTION_FAILED",
  DECRYPTION_FAILED = "DECRYPTION_FAILED",

  // Payment Errors
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  PAYMENT_TIMEOUT = "PAYMENT_TIMEOUT",
  PAYMENT_REJECTED = "PAYMENT_REJECTED",
  INVALID_AMOUNT = "INVALID_AMOUNT",

  // General Errors
  CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
  NETWORK_ERROR = "NETWORK_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/**
 * SMART_ROUTER: Base Smart Router Error
 *
 * Purpose: Base class for all Smart Router errors with security context
 *
 * Security: Includes security-relevant metadata without exposing sensitive data
 *
 * @since smart-router-v1
 */
export class SmartRouterError extends DomainError {
  constructor(
    public readonly code: SmartRouterErrorCode,
    public readonly userMessage: string,
    public readonly details: {
      readonly originalError?: Error
      readonly adapterId?: string
      readonly routeId?: string
      readonly recoverable: boolean
      readonly securityLevel: "low" | "medium" | "high"
      readonly metadata?: Record<string, unknown>
    },
  ) {
    super(userMessage)
    this.name = "SmartRouterError"
  }
}

/**
 * SMART_ROUTER: Adapter Error
 *
 * Purpose: Errors related to payment adapter operations
 *
 * Security: Adapter errors may indicate security issues or attacks
 *
 * @since smart-router-v1
 */
export class AdapterError extends SmartRouterError {
  constructor(
    code: SmartRouterErrorCode,
    userMessage: string,
    public readonly adapterId: string,
    public readonly adapterType: string,
    details: Omit<SmartRouterError["details"], "adapterId">,
  ) {
    super(code, userMessage, { ...details, adapterId })
    this.name = "AdapterError"
  }
}

/**
 * SMART_ROUTER: Routing Error
 *
 * Purpose: Errors related to payment routing and route execution
 *
 * Security: Routing failures may indicate network attacks or manipulation
 *
 * @since smart-router-v1
 */
export class RoutingError extends SmartRouterError {
  constructor(
    code: SmartRouterErrorCode,
    userMessage: string,
    public readonly routeId?: string,
    public readonly attemptedRoutes?: number,
    details?: Omit<SmartRouterError["details"], "routeId">,
  ) {
    super(code, userMessage, {
      recoverable: false,
      securityLevel: "low",
      ...details,
      routeId,
    })
    this.name = "RoutingError"
  }
}

/**
 * SMART_ROUTER: Token Error
 *
 * Purpose: Errors related to Cashu token operations
 *
 * Security: Token errors are critical as they involve bearer assets
 *
 * @since smart-router-v1
 */
export class TokenError extends SmartRouterError {
  constructor(
    code: SmartRouterErrorCode,
    userMessage: string,
    public readonly tokenId?: string,
    public readonly mintUrl?: string,
    details?: Omit<SmartRouterError["details"], "metadata"> & {
      readonly metadata?: Record<string, unknown> & {
        readonly tokenValue?: bigint
        readonly tokenAge?: number
      }
    },
  ) {
    super(code, userMessage, details || { recoverable: false, securityLevel: "high" })
    this.name = "TokenError"
  }
}

/**
 * SMART_ROUTER: Vault Error
 *
 * Purpose: Errors related to secure storage operations
 *
 * Security: Vault errors are always high security level
 *
 * @since smart-router-v1
 */
export class VaultError extends SmartRouterError {
  constructor(
    code: SmartRouterErrorCode,
    userMessage: string,
    public readonly operation: string,
    details?: Omit<SmartRouterError["details"], "securityLevel">,
  ) {
    super(code, userMessage, {
      recoverable: false,
      securityLevel: "high",
      ...details,
    })
    this.name = "VaultError"
  }
}

/**
 * SMART_ROUTER: Error Factory Functions
 *
 * Purpose: Convenience functions for creating common errors
 *
 * @since smart-router-v1
 */

export const createAdapterNotFoundError = (adapterId: string): AdapterError =>
  new AdapterError(
    SmartRouterErrorCode.ADAPTER_NOT_FOUND,
    "Payment source not available",
    adapterId,
    "unknown",
    { recoverable: false, securityLevel: "low" },
  )

export const createInsufficientFundsError = (
  required: bigint,
  available: bigint,
): SmartRouterError =>
  new SmartRouterError(
    SmartRouterErrorCode.INSUFFICIENT_FUNDS,
    "Insufficient funds for payment",
    {
      recoverable: false,
      securityLevel: "low",
      metadata: { required: required.toString(), available: available.toString() },
    },
  )

export const createNoRouteFoundError = (
  amount: bigint,
  recipientType: string,
): RoutingError =>
  new RoutingError(
    SmartRouterErrorCode.NO_ROUTE_FOUND,
    "No payment route available",
    undefined,
    0,
    {
      recoverable: false,
      securityLevel: "low",
      metadata: { amount: amount.toString(), recipientType },
    },
  )

export const createTokenExpiredError = (tokenId: string): TokenError =>
  new TokenError(
    SmartRouterErrorCode.TOKEN_EXPIRED,
    "Payment token has expired",
    tokenId,
    undefined,
    { recoverable: false, securityLevel: "medium" },
  )

export const createVaultLockedError = (): VaultError =>
  new VaultError(
    SmartRouterErrorCode.VAULT_LOCKED,
    "Secure storage is locked",
    "vault_access",
    { recoverable: true, securityLevel: "high" },
  )
