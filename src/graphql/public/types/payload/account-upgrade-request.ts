import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"

import AccountUpgradeRequest from "../object/account-upgrade-request"

const AccountUpgradeRequestPayload = GT.Object({
  name: "AccountUpgradeRequestPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    upgradeRequest: {
      type: AccountUpgradeRequest,
    },
  }),
})

export default AccountUpgradeRequestPayload
