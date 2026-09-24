import { RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"
import { IdVerificationStatus } from "@services/frappe/models/IdVerification"

// The customer-facing state of an upgrade request, derived from the Account
// Upgrade Request (the decision of record) and its ID Verification companion
// (the review pipeline). Wire values are what the GraphQL enum serializes.
export const UpgradeVerificationStatus = {
  Submitted: "SUBMITTED",
  UnderReview: "UNDER_REVIEW",
  MoreInfoNeeded: "MORE_INFO_NEEDED",
  Approved: "APPROVED",
  Rejected: "REJECTED",
} as const

export type UpgradeVerificationStatus =
  (typeof UpgradeVerificationStatus)[keyof typeof UpgradeVerificationStatus]

// The AUR decides the terminal states; the IDV only refines "still pending".
//
//   AUR Approved                                   → APPROVED
//   AUR Rejected                                   → REJECTED
//   AUR Pending + IDV "Resubmit requested"         → MORE_INFO_NEEDED
//   AUR Pending + IDV "Ready for review"           → UNDER_REVIEW
//   AUR Pending + IDV "Checks unavailable"         → UNDER_REVIEW
//   AUR Pending + IDV "Checks pending" | no IDV    → SUBMITTED
//
// An IDV that is itself Approved/Rejected while the AUR is still Pending is a
// reviewer mid-flight (the admin panel decides both together); it reads as
// UNDER_REVIEW until the AUR catches up. The latest-request query never
// returns a Closed AUR; if one arrives it derives like Pending.
export const deriveUpgradeVerificationStatus = ({
  upgradeRequestStatus,
  idVerificationStatus,
}: {
  upgradeRequestStatus: string
  idVerificationStatus?: string | null
}): UpgradeVerificationStatus => {
  if (upgradeRequestStatus === RequestStatus.Approved) {
    return UpgradeVerificationStatus.Approved
  }
  if (upgradeRequestStatus === RequestStatus.Rejected) {
    return UpgradeVerificationStatus.Rejected
  }

  switch (idVerificationStatus) {
    case IdVerificationStatus.ResubmitRequested:
      return UpgradeVerificationStatus.MoreInfoNeeded
    case IdVerificationStatus.ReadyForReview:
    case IdVerificationStatus.ChecksUnavailable:
    case IdVerificationStatus.Approved:
    case IdVerificationStatus.Rejected:
      return UpgradeVerificationStatus.UnderReview
    case IdVerificationStatus.ChecksPending:
    case undefined:
    case null:
    default:
      return UpgradeVerificationStatus.Submitted
  }
}
