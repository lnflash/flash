import { Accounts } from "@app"
import { GT } from "@graphql/index"
import AccountLevel from "@graphql/shared/types/scalar/account-level"

import AccountUpgradeVerification from "./account-upgrade-verification"
import Address from "./address"
import BankAccount from "./bank-account"

const AccountUpgradeRequest = GT.Object({
  name: "AccountUpgradeRequest",
  fields: () => ({
    name: {
      type: GT.NonNull(GT.String),
      description: "ERPNext document name",
    },
    username: {
      type: GT.NonNull(GT.String),
    },
    currentLevel: {
      type: GT.NonNull(AccountLevel),
    },
    requestedLevel: {
      type: GT.NonNull(AccountLevel),
    },
    status: {
      type: GT.NonNull(GT.String),
      description: "Status of the upgrade request",
    },
    fullName: {
      type: GT.NonNull(GT.String),
    },
    phoneNumber: {
      type: GT.NonNull(GT.String),
    },
    email: {
      type: GT.String,
    },
    idDocument: {
      type: GT.NonNull(GT.Boolean),
      resolve: (source) => !!source.idDocument && source.idDocument !== "",
    },
    address: {
      type: GT.NonNull(Address),
      // A Level 2 request filed by the Bridge KYC auto-upgrade
      // (frappe-flash-admin bridge_kyc_upgrade) carries no address. Address's
      // non-null fields resolve to "" so the request still resolves: a null
      // there nulls the whole request, which the app's
      // LatestAccountUpgradeRequest query surfaces as an error.
      resolve: (source) => ({
        ...source.address,
        title: source.address?.title ?? "",
        line1: source.address?.line1 ?? "",
        city: source.address?.city ?? "",
        state: source.address?.state ?? "",
        country: source.address?.country ?? "",
      }),
    },
    terminalsRequested: {
      type: GT.NonNull(GT.Int),
    },
    bankAccount: {
      type: BankAccount,
    },
    verification: {
      type: GT.NonNull(AccountUpgradeVerification),
      description:
        "Identity verification state of this request. `status` above is the raw " +
        "ERPNext value; prefer this for anything shown to the customer.",
      resolve: (source) => Accounts.getUpgradeVerification(source),
    },
  }),
})

export default AccountUpgradeRequest
