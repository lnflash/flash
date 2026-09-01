import { EVIDENCE_RETENTION_DRY_RUN, EVIDENCE_RETENTION_YEARS } from "@config"
import {
  EvidenceDecisionStatus,
  evidenceExpiresAt,
  getAccountClosedAt,
  isEvidenceDecisionStatus,
  isEvidenceExpired,
} from "@domain/accounts"
import ErpNext from "@services/frappe/ErpNext"
import { IdVerification } from "@services/frappe/models/IdVerification"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import { deleteIdDocument } from "@services/storage"

// Evidence retention job (docs/id-verification.md, "Retention").
//
// For every ERPNext ID Verification with undeleted evidence files:
//   1. read the linked Account Upgrade Request's decision (status + when)
//   2. for Approved, read the account's closed-at from Mongo statusHistory
//   3. expiry = domain evidenceExpiresAt(...)
//   4. if expired: delete each file from Spaces and stamp deleted_at on the
//      ERPNext row (dry-run only logs)
// Per-record errors are counted, logged and skipped; the job itself only
// fails on a listing error.

export type EvidenceRetentionSummary = {
  dryRun: boolean
  retentionYears: number
  scanned: number
  expired: number
  filesDeleted: number
  filesWouldDelete: number
  skipped: number
  errors: number
}

const logger = baseLogger.child({ module: "evidence-retention" })

export const runEvidenceRetention = async ({
  dryRun = EVIDENCE_RETENTION_DRY_RUN,
  retentionYears = EVIDENCE_RETENTION_YEARS,
  now = new Date(),
  pageSize = 100,
}: {
  dryRun?: boolean
  retentionYears?: number
  now?: Date
  pageSize?: number
} = {}): Promise<EvidenceRetentionSummary | ApplicationError> => {
  const summary: EvidenceRetentionSummary = {
    dryRun,
    retentionYears,
    scanned: 0,
    expired: 0,
    filesDeleted: 0,
    filesWouldDelete: 0,
    skipped: 0,
    errors: 0,
  }

  if (!ErpNext) {
    logger.warn("ERPNext not configured; evidence retention skipped")
    return summary
  }

  const accounts = AccountsRepository()

  for (let limitStart = 0; ; limitStart += pageSize) {
    const names = await ErpNext.getIdVerificationList({
      limitStart,
      pageLength: pageSize,
    })
    if (names instanceof Error) return names
    if (names.length === 0) break

    for (const name of names) {
      summary.scanned++
      const outcome = await processIdVerification({
        name,
        dryRun,
        retentionYears,
        now,
        findAccountByUsername: (username) =>
          accounts.findByUsername(username as Username),
      })
      if (outcome instanceof Error) {
        summary.errors++
        logger.error(
          { name, error: outcome.message },
          "evidence retention: record failed",
        )
        continue
      }
      if (!outcome.expired) {
        summary.skipped++
        continue
      }
      summary.expired++
      summary.filesDeleted += outcome.filesDeleted
      summary.filesWouldDelete += outcome.filesWouldDelete
      summary.errors += outcome.fileErrors
    }

    if (names.length < pageSize) break
  }

  logger.info(
    { ...summary },
    dryRun ? "evidence retention (dry run)" : "evidence retention",
  )
  return summary
}

type RecordOutcome = {
  expired: boolean
  filesDeleted: number
  filesWouldDelete: number
  fileErrors: number
}

const processIdVerification = async ({
  name,
  dryRun,
  retentionYears,
  now,
  findAccountByUsername,
}: {
  name: string
  dryRun: boolean
  retentionYears: number
  now: Date
  findAccountByUsername: (username: string) => Promise<Account | RepositoryError>
}): Promise<RecordOutcome | Error> => {
  const none: RecordOutcome = {
    expired: false,
    filesDeleted: 0,
    filesWouldDelete: 0,
    fileErrors: 0,
  }

  const doc = await ErpNext.getIdVerificationById(name)
  if (doc instanceof Error) return doc

  const pendingRows = doc.evidence.filter((row) => row.fileKey && !row.deletedAt)
  if (pendingRows.length === 0) return none

  const decision = await ErpNext.getUpgradeRequestDecision(doc.upgradeRequest)
  if (decision instanceof Error) return decision
  if (!isEvidenceDecisionStatus(decision.status)) {
    return new Error(`Unknown upgrade request status "${decision.status}"`)
  }
  if (decision.status === EvidenceDecisionStatus.Pending) return none

  let accountClosedAt: Date | null = null
  if (decision.status === EvidenceDecisionStatus.Approved) {
    const account = await findAccountByUsername(decision.username)
    if (account instanceof Error) return account
    accountClosedAt = getAccountClosedAt(account)
  }

  const expiresAt = evidenceExpiresAt({
    decisionStatus: decision.status,
    decidedAt: decision.decidedAt,
    accountClosedAt,
    retentionYears,
  })
  if (!isEvidenceExpired({ expiresAt, now })) return none

  const outcome: RecordOutcome = { ...none, expired: true }
  const deletedRowNames = new Set<string>()

  for (const row of pendingRows) {
    const fileKey = row.fileKey as string
    if (dryRun) {
      logger.info(
        { idVerification: name, upgradeRequest: doc.upgradeRequest, fileKey, expiresAt },
        "evidence retention: would delete",
      )
      outcome.filesWouldDelete++
      continue
    }

    const deleted = await deleteIdDocument({ fileKey })
    if (deleted instanceof Error) {
      logger.error(
        { idVerification: name, fileKey, error: deleted.message },
        "evidence retention: delete failed",
      )
      outcome.fileErrors++
      continue
    }
    outcome.filesDeleted++
    if (row.rowName) deletedRowNames.add(row.rowName)
    logger.info(
      { idVerification: name, upgradeRequest: doc.upgradeRequest, fileKey, expiresAt },
      "evidence retention: deleted",
    )
  }

  if (dryRun || outcome.filesDeleted === 0) return outcome

  // Full table back to ERPNext (rows missing from a PUT are dropped).
  const rows = doc.evidence.map((row) =>
    IdVerification.evidenceRowToErpnext(
      row.rowName && deletedRowNames.has(row.rowName) ? { ...row, deletedAt: now } : row,
    ),
  )
  const updated = await ErpNext.updateIdVerificationEvidence(name, rows)
  if (updated instanceof Error) {
    // Files are gone; the row stamp will be retried next run (delete of a
    // missing key is idempotent on S3-compatible storage).
    logger.error(
      { idVerification: name, error: updated.message },
      "evidence retention: deleted_at not recorded in ERPNext",
    )
    outcome.fileErrors++
  }

  return outcome
}
