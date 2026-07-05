import { Account } from "@services/mongoose/schema"

export type CashWalletCutoverAccountAuditIssue = {
  accountId: string
  role?: string
  errors: string[]
}

export type CashWalletCutoverAccountAuditReport = {
  scanned: number
  invalid: number
  issues: CashWalletCutoverAccountAuditIssue[]
}

type ValidatableAccountDocument = {
  _id: { toString(): string }
  role?: string
  validateSync(): { errors: Record<string, { message: string }> } | undefined
}

/**
 * Data-quality audit (ENG-484 / cutover runbook D1). The pointer-flip step
 * saves the whole account document, so mongoose re-validates EVERY field —
 * an account with pre-existing invalid data (empty username, null
 * statusHistory entry, ...) fails mid-migration even though the cutover never
 * touched those fields. Both were hit live in the ENG-461 rehearsal.
 *
 * Run before `prepare`: every issue reported here is an account that WILL
 * fail at pointer flip unless fixed (or locked out of the run).
 */
export const auditCashWalletCutoverAccounts = async ({
  listAccountDocuments = () =>
    Account.find({}).cursor() as unknown as AsyncIterable<ValidatableAccountDocument>,
}: {
  listAccountDocuments?: () => AsyncIterable<ValidatableAccountDocument>
} = {}): Promise<CashWalletCutoverAccountAuditReport> => {
  const report: CashWalletCutoverAccountAuditReport = {
    scanned: 0,
    invalid: 0,
    issues: [],
  }

  for await (const document of listAccountDocuments()) {
    report.scanned += 1

    const validation = document.validateSync()
    if (validation === undefined) continue

    report.invalid += 1
    report.issues.push({
      accountId: document._id.toString(),
      role: document.role,
      errors: Object.values(validation.errors).map(({ message }) => message),
    })
  }

  return report
}
