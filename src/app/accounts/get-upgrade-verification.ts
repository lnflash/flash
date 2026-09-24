import ErpNext from "@services/frappe/ErpNext"
import { AccountUpgradeRequest } from "@services/frappe/models/AccountUpgradeRequest"
import { fromFrappeDatetime } from "@services/frappe/models/IdVerification"
import { baseLogger } from "@services/logger"

import {
  UpgradeVerificationStatus,
  deriveUpgradeVerificationStatus,
} from "./upgrade-verification-status"

export type UpgradeVerification = {
  status: UpgradeVerificationStatus
  reasonCode?: string
  // The Decision Reason's `user_facing_message`. Never the reviewer's note.
  reasonMessage?: string
  reviewedAt?: Date
}

// A Decision Reason lookup that failed or found nothing; cached for the life
// of one call so the same code is asked once per request at most.
type ReasonCache = Map<string, Promise<string | undefined>>

const lookupReasonMessage = (
  code: string,
  cache: ReasonCache,
  upgradeRequest: string,
): Promise<string | undefined> => {
  const cached = cache.get(code)
  if (cached) return cached
  const lookup = (async () => {
    if (!ErpNext) return undefined
    const reason = await ErpNext.getDecisionReason(code)
    if (reason instanceof Error) {
      baseLogger.warn(
        { err: reason, code, upgradeRequest },
        "Decision Reason lookup failed; returning the code without a message",
      )
      return undefined
    }
    if (!reason) {
      baseLogger.warn(
        { code, upgradeRequest },
        "Decision Reason code has no registry entry; returning the code without a message",
      )
      return undefined
    }
    return reason.user_facing_message || undefined
  })()
  cache.set(code, lookup)
  return lookup
}

// Customer-facing verification state for one upgrade request. Never fails:
// an ERPNext error on the ID Verification read degrades to "no IDV" (so the
// AUR status alone decides) and a Decision Reason error drops the message.
export const getUpgradeVerification = async (
  upgradeRequest: AccountUpgradeRequest,
  reasonCache: ReasonCache = new Map(),
): Promise<UpgradeVerification> => {
  const idv = ErpNext
    ? await ErpNext.getIdVerificationByUpgradeRequest(upgradeRequest.name)
    : null
  const idVerification = idv instanceof Error ? null : idv
  if (idv instanceof Error) {
    baseLogger.warn(
      { err: idv, upgradeRequest: upgradeRequest.name },
      "ID Verification lookup failed; deriving verification status from the upgrade request alone",
    )
  }

  const status = deriveUpgradeVerificationStatus({
    upgradeRequestStatus: upgradeRequest.status,
    idVerificationStatus: idVerification?.status,
  })

  const reasonCode = idVerification?.decision_reason || upgradeRequest.decisionReason
  const reasonMessage = reasonCode
    ? await lookupReasonMessage(reasonCode, reasonCache, upgradeRequest.name)
    : undefined

  const reviewedAt =
    fromFrappeDatetime(idVerification?.reviewed_at) ?? upgradeRequest.reviewedAt

  return { status, reasonCode, reasonMessage, reviewedAt }
}
