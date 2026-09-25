import {
  UpgradeVerificationStatus,
  deriveUpgradeVerificationStatus,
} from "@app/accounts/upgrade-verification-status"
import { RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"
import { IdVerificationStatus } from "@services/frappe/models/IdVerification"

describe("deriveUpgradeVerificationStatus", () => {
  it.each([
    [RequestStatus.Approved, undefined, UpgradeVerificationStatus.Approved],
    [RequestStatus.Approved, IdVerificationStatus.ChecksPending, "APPROVED"],
    [RequestStatus.Approved, IdVerificationStatus.ResubmitRequested, "APPROVED"],
    [RequestStatus.Rejected, undefined, UpgradeVerificationStatus.Rejected],
    [RequestStatus.Rejected, IdVerificationStatus.ReadyForReview, "REJECTED"],
    [RequestStatus.Pending, IdVerificationStatus.ResubmitRequested, "MORE_INFO_NEEDED"],
    [RequestStatus.Pending, IdVerificationStatus.ReadyForReview, "UNDER_REVIEW"],
    [RequestStatus.Pending, IdVerificationStatus.ChecksUnavailable, "UNDER_REVIEW"],
    [RequestStatus.Pending, IdVerificationStatus.Approved, "UNDER_REVIEW"],
    [RequestStatus.Pending, IdVerificationStatus.Rejected, "UNDER_REVIEW"],
    [RequestStatus.Pending, IdVerificationStatus.ChecksPending, "SUBMITTED"],
    [RequestStatus.Pending, undefined, "SUBMITTED"],
    [RequestStatus.Pending, null, "SUBMITTED"],
    [RequestStatus.Pending, "Some future status", "SUBMITTED"],
    // The latest-request query never returns Closed; derives like Pending.
    [RequestStatus.Closed, IdVerificationStatus.ReadyForReview, "UNDER_REVIEW"],
    [RequestStatus.Closed, undefined, "SUBMITTED"],
  ])("AUR %s + IDV %s → %s", (upgradeRequestStatus, idVerificationStatus, expected) => {
    expect(
      deriveUpgradeVerificationStatus({ upgradeRequestStatus, idVerificationStatus }),
    ).toBe(expected)
  })

  it("only ever returns one of the five wire values", () => {
    const wire = new Set<string>(Object.values(UpgradeVerificationStatus))
    for (const aur of [...Object.values(RequestStatus), "junk"]) {
      for (const idv of [...Object.values(IdVerificationStatus), undefined, "junk"]) {
        expect(
          wire.has(
            deriveUpgradeVerificationStatus({
              upgradeRequestStatus: aur,
              idVerificationStatus: idv,
            }),
          ),
        ).toBe(true)
      }
    }
  })
})
