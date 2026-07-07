import { GT } from "@graphql/index"

const CashWalletCutoverState = GT.Enum({
  name: "CashWalletCutoverState",
  values: {
    PRE: { value: "pre" },
    IN_PROGRESS: { value: "in_progress" },
    COMPLETE: { value: "complete" },
    // Terminal state for a run reversed via the ENG-401 rollback path; a new
    // run (fresh runId) may be prepared and started afterwards.
    ROLLED_BACK: { value: "rolled_back" },
  },
})

export default CashWalletCutoverState
