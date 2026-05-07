import { Accounts } from "@app"

import { GT } from "@graphql/index"
import Bank from "@graphql/public/types/object/bank"
import { BanksQueryError } from "@services/frappe/errors"
import { InternalServerError } from "@graphql/error"
import { baseLogger } from "@services/logger"

const SupportedBanksQuery = GT.Field({
  type: GT.NonNullList(Bank),
  resolve: async () => {
    const banks = await Accounts.getSupportedBanks()
    if (banks instanceof BanksQueryError) return new InternalServerError({ logger: baseLogger })
    return banks
  },
})

export default SupportedBanksQuery
