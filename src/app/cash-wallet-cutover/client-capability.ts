export const CASH_WALLET_USDT_CLIENT_CAPABILITY = "cash-wallet-usdt-v1"

export type CashWalletPresentation = "legacy_compat" | "usdt"

export type CashWalletClientCapabilities = {
  cashWalletPresentation: CashWalletPresentation
  hasUsdtCashWalletSupport: boolean
}

export const DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES: CashWalletClientCapabilities = {
  cashWalletPresentation: "legacy_compat",
  hasUsdtCashWalletSupport: false,
}

export const parseCashWalletClientCapabilities = (
  headers: Record<string, unknown>,
): CashWalletClientCapabilities => {
  const values = Object.entries(headers).flatMap(([key, raw]) => {
    if (key.toLowerCase() !== "x-flash-client-capabilities") return []
    if (typeof raw === "string") return [raw]
    if (Array.isArray(raw))
      return raw.filter((value): value is string => typeof value === "string")
    return []
  })

  const capabilities = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())

  const hasUsdtCashWalletSupport = capabilities.includes(
    CASH_WALLET_USDT_CLIENT_CAPABILITY,
  )

  if (!hasUsdtCashWalletSupport) return DEFAULT_CASH_WALLET_CLIENT_CAPABILITIES

  return { cashWalletPresentation: "usdt", hasUsdtCashWalletSupport }
}
