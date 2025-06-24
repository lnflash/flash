export const AccountLevel = {
  Zero: 0,
  One: 1,
  Two: 2,
  Three: 3,
} as const

export const AccountStatus = {
  New: "new",
  Pending: "pending",
  Active: "active",
  Locked: "locked",
  Closed: "closed",
} as const

export const AccountLimitsRange = {
  ONE_DAY: "ONE_DAY",
} as const

export const AccountLimitsType = {
  Withdrawal: "Withdrawal",
  IntraLedger: "IntraLedger",
  SelfTrade: "TradeIntraAccount",
} as const

/**
 * CASHIER_ROLE: Updated AccountRoles enum
 *
 * Purpose: Extend existing roles to include cashier role for POS/teller operations.
 * The cashier role enables restricted access to view transactions and generate reports.
 *
 * Security: Cashier role has limited read-only permissions by default.
 * Specific permissions must be granted through cashierPermissions array.
 *
 * @modified cashier-role-v1
 * @security-review pending
 * @milestone 1
 */
export const AccountRoles = {
  dealer: "dealer", // deprecated. does not apply to flash
  funder: "funder", // deprecated. does not apply to flash
  bankowner: "bankowner",
  user: "user",
  editor: "editor",
  cashier: "cashier", // NEW: Added for cashier role feature
}
