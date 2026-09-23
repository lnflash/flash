import { GT } from "@graphql/index"

import IError from "../../../shared/types/abstract/error"
import BankAccount from "../object/bank-account"

const BankAccountPayload = GT.Object({
  name: "BankAccountPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    bankAccount: {
      type: BankAccount,
      description:
        "The bank account as stored after the change. Null when errors occurred.",
    },
  }),
})

export default BankAccountPayload
