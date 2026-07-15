import { GT } from "@graphql/index"

// ENG-516: capability flags replace tier nomenclature (Pro/International are
// retired). Levels stay internal; clients present these flags as badges.
const AccountCapabilities = GT.Object({
  name: "AccountCapabilities",
  fields: () => ({
    verified: {
      type: GT.NonNull(GT.Boolean),
      description: "Phone and identity verified.",
    },
    bankPayout: {
      type: GT.NonNull(GT.Boolean),
      description: "An approved bank account is on file for payouts.",
    },
    business: {
      type: GT.NonNull(GT.Boolean),
      description: "Business profile (name and address) on file.",
    },
    usdAccount: {
      type: GT.NonNull(GT.Boolean),
      description:
        "USD account and routing number available (Bridge KYC approved). Orthogonal to the other capabilities.",
    },
  }),
})

export default AccountCapabilities
