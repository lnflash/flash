import { GT } from "@graphql/index"

const CashWalletCutoverState = GT.Enum({
  name: "CashWalletCutoverState",
  values: {
    PRE: { value: "pre" },
    IN_PROGRESS: { value: "in_progress" },
    COMPLETE: { value: "complete" },
  },
})

export default CashWalletCutoverState
