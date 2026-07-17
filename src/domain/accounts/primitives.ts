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
}
