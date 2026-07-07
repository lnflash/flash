import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import { requestPrimaryCashWalletRollback } from "@app/cash-wallet-cutover"

const CashWalletCutoverRollbackInput = GT.Input({
  name: "CashWalletCutoverRollbackInput",
  fields: () => ({
    cutoverVersion: { type: GT.NonNull(GT.Int) },
    runId: { type: GT.NonNull(GT.String) },
    // Single-account rollback when set; whole-run rollback when omitted.
    accountId: { type: GT.String },
    reason: { type: GT.NonNull(GT.String) },
    dryRun: { type: GT.Boolean },
  }),
})

const CashWalletCutoverRollbackPayload = GT.Object({
  name: "CashWalletCutoverRollbackPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    dryRun: { type: GT.Boolean },
    eligible: { type: GT.Int },
    requested: { type: GT.Int },
    migrationIds: { type: GT.List(GT.String) },
    skippedByStatus: { type: GT.List(GT.String) },
  }),
})

// ENG-401 #6: admin-only rollback request. Marks eligible migrations
// `rollback_started` (single-account or full-run); execution happens in
// locked worker batches (CLI `rollback-batch` / runPrimaryCashWalletRollbackBatch),
// so this mutation is fast, idempotent (already-rolled-back records are
// skips), and resumable after partial failures. `skipped_already_migrated`
// accounts are never eligible — they stay on USDT.
const CashWalletCutoverRollbackMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      cutoverVersion: number
      runId: string
      accountId?: string
      reason: string
      dryRun?: boolean
    }
  }
>({
  type: GT.NonNull(CashWalletCutoverRollbackPayload),
  args: {
    input: { type: GT.NonNull(CashWalletCutoverRollbackInput) },
  },
  resolve: async (_, { input }, ctx) => {
    const report = await requestPrimaryCashWalletRollback({
      cutoverVersion: input.cutoverVersion,
      runId: input.runId,
      accountId: input.accountId as AccountId | undefined,
      reason: input.reason,
      requestedBy: ctx.user.id,
      dryRun: input.dryRun ?? false,
    })
    if (report instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(report)] }
    }

    return {
      errors: [],
      dryRun: report.dryRun,
      eligible: report.eligible,
      requested: report.requested,
      migrationIds: report.migrationIds,
      skippedByStatus: Object.entries(report.skipped).map(
        ([status, count]) => `${status}:${count}`,
      ),
    }
  },
})

export default CashWalletCutoverRollbackMutation
