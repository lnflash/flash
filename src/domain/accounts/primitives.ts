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

export const AccountRoles = {
  dealer: "dealer", // deprecated. does not apply to flash
  funder: "funder", // deprecated. does not apply to flash
  bankowner: "bankowner",
  user: "user",
  editor: "editor",
}
