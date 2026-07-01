jest.mock("@config", () => {
  const path = jest.requireActual<typeof import("path")>("path")
  const { I18n } = jest.requireActual<typeof import("i18n")>("i18n")
  const i18n = new I18n()
  i18n.configure({
    objectNotation: true,
    updateFiles: false,
    locales: ["en", "es"],
    defaultLocale: "en",
    retryInDefaultLocale: true,
    directory: path.resolve(__dirname, "../../../../../src/config/locales"),
  })
  return {
    getI18nInstance: () => i18n,
    getLocale: () => "en",
  }
})

import {
  BRIDGE_WITHDRAWAL_FLASH_FEE_NOTICE_PHRASE,
  getBridgeWithdrawalFlashFeeNotice,
  getBridgeWithdrawalFlashFeeNoticeForUser,
} from "@app/bridge/get-withdrawal-flash-fee-notice"

describe("getBridgeWithdrawalFlashFeeNotice", () => {
  it("uses the configured i18n phrase for supported languages", () => {
    expect(BRIDGE_WITHDRAWAL_FLASH_FEE_NOTICE_PHRASE).toBe(
      "notification.bridgeWithdrawal.flashFeeNotice",
    )
    expect(getBridgeWithdrawalFlashFeeNotice("en")).toContain("estimates")
    expect(getBridgeWithdrawalFlashFeeNotice("es")).toContain("estimados")
  })

  it("falls back to the default locale when the user language is empty", () => {
    expect(getBridgeWithdrawalFlashFeeNoticeForUser({ language: "" })).toBe(
      getBridgeWithdrawalFlashFeeNotice("en"),
    )
  })
})
