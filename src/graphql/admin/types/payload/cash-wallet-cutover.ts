import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"
import CashWalletCutoverObject from "@graphql/shared/types/object/cash-wallet-cutover"

const CashWalletCutoverPayload = GT.Object({
  name: "CashWalletCutoverPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    cashWalletCutover: { type: CashWalletCutoverObject },
  }),
})

export default CashWalletCutoverPayload
