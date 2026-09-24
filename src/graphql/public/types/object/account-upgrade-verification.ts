import type { UpgradeVerificationStatus } from "@app/accounts/upgrade-verification-status"
import { GT } from "@graphql/index"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

// `value:` is typed as the app-layer union so a rename on either side is a
// compile error (same reasoning as FygaroTopupState).
const STATUS_ENUM_VALUES: Record<
  string,
  { value: UpgradeVerificationStatus; description: string }
> = {
  SUBMITTED: {
    value: "SUBMITTED",
    description: "Received; automated checks have not finished yet.",
  },
  UNDER_REVIEW: {
    value: "UNDER_REVIEW",
    description: "Checks are done (or could not run) and a reviewer has it.",
  },
  MORE_INFO_NEEDED: {
    value: "MORE_INFO_NEEDED",
    description:
      "A reviewer asked for something to be resubmitted. reasonMessage says what.",
  },
  APPROVED: { value: "APPROVED", description: "Upgrade granted." },
  REJECTED: {
    value: "REJECTED",
    description: "Upgrade declined. reasonMessage says why, when a reason was recorded.",
  },
}

export const AccountUpgradeVerificationStatus = GT.Enum({
  name: "AccountUpgradeVerificationStatus",
  values: STATUS_ENUM_VALUES,
})

const AccountUpgradeVerification = GT.Object({
  name: "AccountUpgradeVerification",
  description:
    "Where an upgrade request is in identity verification, derived from the " +
    "request's decision and its ID Verification review state.",
  fields: () => ({
    status: { type: GT.NonNull(AccountUpgradeVerificationStatus) },
    reasonCode: {
      type: GT.String,
      description: "Decision Reason code recorded by the reviewer, e.g. RESUBMIT_BLURRY.",
    },
    reasonMessage: {
      type: GT.String,
      description:
        "Plain-language message for the customer matching reasonCode. Null when " +
        "no reason was recorded or its text could not be fetched; never an " +
        "internal reviewer note.",
    },
    reviewedAt: {
      type: Timestamp,
      description: "When the reviewer last decided, if they have.",
    },
  }),
})

export default AccountUpgradeVerification
