/**
 * CASHIER_ROLE: Cashier Domain Implementation
 *
 * Purpose: Export constants and types for the cashier domain.
 * This file contains the actual implementations while index.types.d.ts
 * contains the type definitions.
 *
 * Security: All exports are immutable constants or pure functions.
 *
 * Dependencies:
 * - None for constants
 *
 * @since cashier-role-v1
 * @security-review pending
 * @milestone 1
 */

/**
 * CASHIER_ROLE: Cashier Permission Constants
 *
 * Purpose: Defines granular permissions for cashier operations.
 * Each permission grants access to specific read-only operations.
 *
 * Security: All permissions follow principle of least privilege.
 * No permission grants access beyond its explicit scope.
 *
 * Error Handling: N/A - const definition
 *
 * @example
 * ```typescript
 * // Check if user has permission
 * if (account.cashierPermissions.includes(CashierPermission.ViewTransactions)) {
 *   // Allow viewing transactions
 * }
 * ```
 *
 * @since cashier-role-v1
 * @security-review pending
 * @milestone 1
 */
export const CashierPermission = {
  /**
   * Allows viewing transaction history for any user account.
   * Does NOT include ability to modify or create transactions.
   */
  ViewTransactions: "VIEW_TRANSACTIONS",

  /**
   * Allows viewing user wallet balances.
   * Does NOT include transaction details or history.
   */
  ViewUserBalances: "VIEW_USER_BALANCES",

  /**
   * Allows generating reports from transaction data.
   * Limited to predefined report types with no raw data export.
   */
  GenerateReports: "GENERATE_REPORTS",

  /**
   * Allows viewing audit logs for cashier's own actions.
   * Does NOT include logs from other cashiers or system logs.
   */
  AccessAuditLogs: "ACCESS_AUDIT_LOGS",
} as const
