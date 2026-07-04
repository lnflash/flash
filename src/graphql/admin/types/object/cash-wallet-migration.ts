import { GT } from "@graphql/index"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

// Admin-only view of a per-account cutover migration record (ENG-401).
// Exposes previousDefaultWalletId and the full rollback audit trail so
// operators never need direct DB access during an incident. The status
// fields are plain strings on purpose: the internal status set evolves with
// the state machine and this surface must never lag it.
const CashWalletMigrationObject = GT.Object<CashWalletMigration>({
  name: "CashWalletMigration",
  fields: () => ({
    id: { type: GT.NonNullID },
    accountId: { type: GT.NonNull(GT.String) },
    status: { type: GT.NonNull(GT.String) },
    runId: { type: GT.NonNull(GT.String) },
    cutoverVersion: { type: GT.NonNull(GT.Int) },
    legacyUsdWalletId: { type: GT.NonNull(GT.String) },
    destinationUsdtWalletId: { type: GT.NonNull(GT.String) },
    previousDefaultWalletId: { type: GT.String },
    sourceBalanceUsdCents: { type: GT.String },
    destinationAmountUsdtMicros: { type: GT.String },
    destinationStartingBalanceUsdtMicros: { type: GT.String },
    feeAmountUsdCents: { type: GT.String },
    feeAmountUsdtMicros: { type: GT.String },
    balanceMovePaymentTransactionId: { type: GT.String },
    feeReimbursementPaymentTransactionId: { type: GT.String },
    attempts: { type: GT.NonNull(GT.Int) },
    lastError: { type: GT.String },
    startedAt: { type: Timestamp },
    completedAt: { type: Timestamp },
    updatedAt: { type: GT.NonNull(Timestamp) },
    rollbackRequestedAt: { type: Timestamp },
    rollbackRequestedBy: { type: GT.String },
    rollbackReason: { type: GT.String },
    rollbackFromStatus: { type: GT.String },
    rollbackPointerRestoredAt: { type: Timestamp },
    rollbackPaymentTransactionId: { type: GT.String },
    rollbackShortfallUsdtMicros: { type: GT.String },
    rollbackShortfallPaymentTransactionId: { type: GT.String },
    rolledBackAt: { type: Timestamp },
  }),
})

export default CashWalletMigrationObject
