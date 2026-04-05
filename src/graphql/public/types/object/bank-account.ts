import { GT } from "@graphql/index"

const BankAccount = GT.Object({
  name: "BankAccount",
  fields: () => ({
    bankName: { type: GT.NonNull(GT.String) },
    bankBranch: { type: GT.NonNull(GT.String) },
    accountType: { type: GT.NonNull(GT.String) },
    currency: { type: GT.NonNull(GT.String) },
    accountNumber: { type: GT.NonNull(GT.String) },
  }),
})

export default BankAccount
