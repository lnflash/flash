import { GT } from "@graphql/index"
import CashWalletMigrationObject from "@graphql/admin/types/object/cash-wallet-migration"
import { CashWalletCutoverRepository } from "@services/mongoose/cash-wallet-cutover"

// ENG-401: operator inspection of migration records (incl.
// previousDefaultWalletId and rollback progress) without direct DB access.
const CashWalletMigrationsQuery = GT.Field<
  null,
  GraphQLAdminContext,
  {
    runId: string
    cutoverVersion: number
    statuses?: string[]
  }
>({
  type: GT.NonNullList(CashWalletMigrationObject),
  args: {
    runId: { type: GT.NonNull(GT.String) },
    cutoverVersion: { type: GT.NonNull(GT.Int) },
    statuses: { type: GT.List(GT.String) },
  },
  resolve: async (_, { runId, cutoverVersion, statuses }) => {
    const repo = CashWalletCutoverRepository()

    const migrations = await repo.listMigrationsByStatuses({
      cutoverVersion,
      runId,
      statuses:
        statuses && statuses.length > 0
          ? (statuses as CashWalletMigrationStatus[])
          : ([
              "not_started",
              "started",
              "provisioned",
              "balance_read",
              "invoice_created",
              "balance_move_sending",
              "balance_move_sent",
              "balance_move_verified",
              "fee_reimbursement_invoice_created",
              "fee_reimbursement_sending",
              "fee_reimbursed",
              "pointer_flipped",
              "legacy_zero_verified",
              "complete",
              "failed",
              "requires_operator_review",
              "skipped_already_migrated",
              "rollback_started",
              "rolled_back",
            ] as CashWalletMigrationStatus[]),
    })
    if (migrations instanceof Error) throw migrations

    return migrations
  },
})

export default CashWalletMigrationsQuery
