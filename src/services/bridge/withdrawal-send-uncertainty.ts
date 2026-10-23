import { createHash } from "crypto"

import { alertBridge } from "@services/alerts"
import { baseLogger } from "@services/logger"

type Reason =
  | "unresolved_prior_send"
  | "attempt_reservation_unconfirmed"
  | "provider_outcome_unconfirmed"
  | "provider_pending_confirmation"
  | "review_progress_unconfirmed"
  | "send_receipt_unconfirmed"
  | "legacy_send_outcome_unconfirmed"

export const reportWithdrawalSendUncertainty = (
  withdrawalId: string,
  reason: Reason,
): void => {
  // A stable one-way reference permits operator correlation without exporting
  // account IDs, addresses, amounts, provider responses or credential material.
  const reference = createHash("sha256")
    .update(`bridge-send:${withdrawalId}`)
    .digest("hex")
  baseLogger.error(
    { operation: "bridge_withdrawal_send", reason, reference },
    "Withdrawal send requires manual review",
  )
  try {
    alertBridge({
      source: "ibex",
      severity: "warning",
      dedupKey: `bridge-withdrawal-send:${reference}`,
      title: "Bridge withdrawal send requires review",
      detail:
        "A withdrawal send has an unresolved outcome. Do not retry or cancel automatically.",
      context: { reason, reference },
    })
  } catch {
    baseLogger.error(
      { operation: "bridge_withdrawal_send", outcome: "alert_unavailable" },
      "Withdrawal review alert unavailable",
    )
  }
}
