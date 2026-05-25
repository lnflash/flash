import {
  CASH_WALLET_USDT_CLIENT_CAPABILITY,
  parseCashWalletClientCapabilities,
} from "@app/cash-wallet-cutover/client-capability"

describe("cash wallet client capability parser", () => {
  it("defaults missing headers to legacy compatibility", () => {
    expect(parseCashWalletClientCapabilities({})).toEqual({
      cashWalletPresentation: "legacy_compat",
      hasUsdtCashWalletSupport: false,
    })
  })

  it("treats unknown capabilities as legacy compatibility", () => {
    expect(
      parseCashWalletClientCapabilities({
        "x-flash-client-capabilities": "contacts-v2",
      }),
    ).toEqual({
      cashWalletPresentation: "legacy_compat",
      hasUsdtCashWalletSupport: false,
    })
  })

  it("detects the USDT Cash Wallet capability", () => {
    expect(
      parseCashWalletClientCapabilities({
        "x-flash-client-capabilities": `contacts-v2, ${CASH_WALLET_USDT_CLIENT_CAPABILITY}`,
      }),
    ).toEqual({
      cashWalletPresentation: "usdt",
      hasUsdtCashWalletSupport: true,
    })
  })

  it("accepts native client connection-param casing", () => {
    expect(
      parseCashWalletClientCapabilities({
        "X-Flash-Client-Capabilities": CASH_WALLET_USDT_CLIENT_CAPABILITY,
      }),
    ).toEqual({
      cashWalletPresentation: "usdt",
      hasUsdtCashWalletSupport: true,
    })
  })
})
