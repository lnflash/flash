import { GT } from "@graphql/index"
import CashWalletCutoverObject from "@graphql/shared/types/object/cash-wallet-cutover"
import { CashWalletCutoverRepository } from "@services/mongoose/cash-wallet-cutover"

const CashWalletCutoverQuery = GT.Field({
  type: GT.NonNull(CashWalletCutoverObject),
  resolve: async () => {
    const config = await CashWalletCutoverRepository().getConfig()
    if (config instanceof Error) throw config
    return config
  },
})

export default CashWalletCutoverQuery
