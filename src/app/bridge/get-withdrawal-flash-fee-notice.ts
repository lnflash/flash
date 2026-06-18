import { getI18nInstance } from "@config"
import { getLanguageOrDefault } from "@domain/locale"

export const BRIDGE_WITHDRAWAL_FLASH_FEE_NOTICE_PHRASE =
  "notification.bridgeWithdrawal.flashFeeNotice"

export const getBridgeWithdrawalFlashFeeNotice = (locale: UserLanguage): string =>
  getI18nInstance().__({ phrase: BRIDGE_WITHDRAWAL_FLASH_FEE_NOTICE_PHRASE, locale })

export const getBridgeWithdrawalFlashFeeNoticeForUser = (
  user?: Pick<User, "language">,
): string => getBridgeWithdrawalFlashFeeNotice(getLanguageOrDefault(user?.language ?? ""))
