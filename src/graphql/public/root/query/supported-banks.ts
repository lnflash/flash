import { Accounts } from "@app"

import { GT } from "@graphql/index"
import { mapError } from "@graphql/error-map"
import Bank from "@graphql/public/types/object/bank"

const SupportedBanksQuery = GT.Field({
  type: GT.NonNullList(Bank),
  resolve: async () => {
    const banks = await Accounts.getSupportedBanks()
    if (banks instanceof Error) throw mapError(banks)

    return banks
  },
})

export default SupportedBanksQuery
