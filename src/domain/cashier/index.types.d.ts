/**
 * CASHIER_ROLE: Implementation Plan for Milestone 1
 *
 * Files to be modified:
 * 1. src/domain/cashier/index.types.d.ts - Create cashier-specific type definitions
 * 2. src/domain/accounts/primitives.ts - Add 'cashier' to AccountRoles enum
 * 3. src/domain/accounts/index.types.d.ts - Extend Account type with cashier fields
 *
 * Security considerations:
 * - Permissions must be explicitly defined with no implicit grants
 * - Permission names should clearly indicate scope of access
 * - No permission should grant write access in this phase
 *
 * Testing approach:
 * - Type compilation tests
 * - Permission validation tests
 * - Type guard function tests
 *
 * Rollback plan:
 * - Remove src/domain/cashier directory
 * - Revert changes to AccountRoles enum
 * - Revert Account type extensions
 *
 * @milestone 1
 * @estimated-loc 100
 * @security-impact low
 */

/**
 * CASHIER_ROLE: Core Type Definitions
 *
 * Purpose: Define the fundamental types for the cashier role feature including
 * permissions, sessions, and related interfaces.
 *
 * Security: All permissions are read-only in this phase. Write permissions
 * will be added in future milestones after security review.
 *
 * Dependencies:
 * - Account domain types
 * - Shared domain types
 *
 * Side Effects:
 * - None (type definitions only)
 *
 * @since cashier-role-v1
 * @security-review pending
 * @milestone 1
 */

/**
 * CASHIER_ROLE: Cashier Permission Type
 *
 * Purpose: Type definition for cashier permissions following the same pattern
 * as other domain types in the codebase.
 *
 * Security: All permissions follow principle of least privilege.
 * No permission grants access beyond its explicit scope.
 *
 * @since cashier-role-v1
 */
type CashierPermission =
  (typeof import("./index").CashierPermission)[keyof typeof import("./index").CashierPermission]

/**
 * CASHIER_ROLE: Type Aliases
 *
 * Purpose: Define branded types for cashier-specific identifiers
 * following the pattern used throughout the codebase.
 *
 * @since cashier-role-v1
 */
type SessionId = string & { readonly brand: unique symbol }
type TerminalId = string & { readonly brand: unique symbol }
type IpAddress = string & { readonly brand: unique symbol }

/**
 * CASHIER_ROLE: Cashier Session Interface
 *
 * Purpose: Represents an active cashier session with PIN-based authentication.
 * Used for tracking shift-based access and quick re-authentication.
 *
 * Security:
 * - Session IDs must be cryptographically secure random values
 * - PIN fields should never be logged or exposed in responses
 * - All timestamps used for session expiry validation
 *
 * Dependencies:
 * - AccountId from accounts domain
 * - IpAddress from shared domain
 *
 * @since cashier-role-v1
 */
interface CashierSession {
  /** Unique session identifier - cryptographically secure random UUID */
  readonly id: SessionId

  /** Account ID of the cashier */
  readonly accountId: AccountId

  /** Optional terminal identifier for location-based sessions */
  readonly terminalId?: TerminalId

  /** Timestamp when the shift started */
  readonly shiftStartTime: Date

  /** Timestamp of last activity for timeout tracking */
  lastActivityTime: Date

  /** Whether PIN authentication is enabled for this session */
  readonly pinEnabled: boolean

  /** Timestamp when PIN expires and full re-authentication is required */
  readonly pinExpiresAt: Date

  /** IP address of the session for security tracking */
  readonly ipAddress: IpAddress

  /** User agent string for device identification */
  readonly userAgent: string
}

/**
 * CASHIER_ROLE: Account Cashier Authentication Fields
 *
 * Purpose: Fields added to Account type for cashier authentication.
 * Stored in MongoDB account document.
 *
 * Security:
 * - PIN must be hashed with bcrypt before storage
 * - Failed attempts tracked to prevent brute force
 * - Lock mechanism prevents repeated attempts
 *
 * @since cashier-role-v1
 */
interface AccountCashierAuth {
  /** Bcrypt hash of the cashier's PIN - never store plaintext */
  pinHash?: string

  /** Timestamp when PIN was created for rotation tracking */
  pinCreatedAt?: Date

  /** Timestamp of last successful PIN usage */
  pinLastUsedAt?: Date

  /** Count of consecutive failed PIN attempts */
  pinFailedAttempts: number

  /** Timestamp until which PIN is locked due to failed attempts */
  pinLockedUntil?: Date

  /** Last authentication method used for login */
  lastLoginMethod: "phone" | "email" | "pin"

  /** Terminal ID for terminal-bound sessions (optional feature) */
  terminalId?: TerminalId

  /** Array of permissions granted to this cashier */
  cashierPermissions: CashierPermission[]
}
