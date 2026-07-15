import { GT } from "@graphql/index"

// ENG-516 "light headline status": the account leads with one word —
// Trial → Verified → Business — with capability badges as supporting detail.
const AccountStatusHeadline = GT.Enum({
  name: "AccountStatusHeadline",
  values: {
    TRIAL: { value: "TRIAL" },
    VERIFIED: { value: "VERIFIED" },
    BUSINESS: { value: "BUSINESS" },
  },
})

export default AccountStatusHeadline
