export const AccountLevel = {
  Zero: 0,
  One: 1,
  Two: 2,
  Three: 3,
  // Semantic aliases. "Business" is the current name (ENG-516); "Pro" and
  // "Merchant" are retired nomenclature kept only for existing call sites.
  Business: 3,
  /** @deprecated retired nomenclature (ENG-516) — L2 is bank-payout-capable, no tier name */
  Pro: 2,
  /** @deprecated renamed to Business (ENG-516) */
  Merchant: 3,
} as const

/**
 * The single place a missing account level is resolved.
 *
 * An account document with no `level` field hydrates as `undefined` — the
 * mongoose schema carries no default, and ~300 prod accounts (174 of them with
 * usernames, i.e. active users) are in that state. An unleveled account is an
 * unverified one, so it reads as level 0 rather than indexing a level map with
 * `undefined` and resolving every limit to `NaN`.
 *
 * Every consumer of `getAccountLimits` has to agree on this or they disagree
 * about the same account: the ENG-573 send guard refusing a send at $125 while
 * the limits screen, fed by `Account.limits` / `remainingLimit`, shows the user
 * something else and support has no way to reconcile the two numbers.
 */
export const effectiveAccountLevel = (level: AccountLevel | undefined): AccountLevel =>
  level ?? AccountLevel.Zero

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

export const AccountRoles = {
  dealer: "dealer", // deprecated. does not apply to flash
  funder: "funder", // deprecated. does not apply to flash
  bankowner: "bankowner",
  user: "user",
  editor: "editor",
  rewards: "rewards", // funding account for referral reward payouts
}
