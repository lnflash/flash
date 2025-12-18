import { AccountLevel } from "@domain/accounts"

type AccountLevelValue = typeof AccountLevel[keyof typeof AccountLevel]

const LEVEL_TO_ERP: Record<AccountLevelValue, string> = {
  [AccountLevel.ZERO]: "ZERO",
  [AccountLevel.One]: "ONE",
  [AccountLevel.Two]: "TWO",
  [AccountLevel.Three]: "THREE",
  // Note: Pro and Merchant are aliases (same as Two/Three), so they're already covered
} as const

type ErpLevelString = typeof LEVEL_TO_ERP[AccountLevelValue]

export const levelToErpString = (level: AccountLevelValue): ErpLevelString => {
  return LEVEL_TO_ERP[level]
}

// Derive the reverse mapping 
const ERP_TO_LEVEL = Object.fromEntries(
  Object.entries(LEVEL_TO_ERP).map(([k, v]) => [v, Number(k)])
) as Record<string, AccountLevelValue>

export const erpStringToLevel = (erpLevel: string): AccountLevelValue => {
  return ERP_TO_LEVEL[erpLevel] ?? AccountLevel.ZERO
}

