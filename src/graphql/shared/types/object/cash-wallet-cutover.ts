import { GT } from "@graphql/index"
import Timestamp from "@graphql/shared/types/scalar/timestamp"
import CashWalletCutoverState from "@graphql/shared/types/scalar/cash-wallet-cutover-state"

const CashWalletCutoverObject = GT.Object<CashWalletCutoverConfig>({
  name: "CashWalletCutover",
  fields: () => ({
    state: { type: GT.NonNull(CashWalletCutoverState) },
    scheduledAt: { type: Timestamp },
    startedAt: { type: Timestamp },
    completedAt: { type: Timestamp },
    pausedAt: { type: Timestamp },
    pauseReason: { type: GT.String },
    cutoverVersion: { type: GT.NonNull(GT.Int) },
    runId: { type: GT.String },
    updatedBy: { type: GT.String },
    updatedAt: { type: GT.NonNull(Timestamp) },
  }),
})

export default CashWalletCutoverObject
