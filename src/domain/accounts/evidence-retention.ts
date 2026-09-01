import { AccountStatus } from "./primitives"

// Retention policy for ID-verification evidence (docs/id-verification.md).
//
// Files are kept for `retentionYears` after the relationship ends:
//   Approved  → the account's closure date + N years (never, while open)
//   Rejected  → the decision date + N years
//   Closed    → the decision date + N years (request superseded/abandoned)
//   Pending   → never (no decision yet)
// Pure functions; the cron job in app/accounts/run-evidence-retention.ts
// feeds them ERPNext + Mongo data.

export const DEFAULT_EVIDENCE_RETENTION_YEARS = 7

export const EvidenceDecisionStatus = {
  Pending: "Pending",
  Approved: "Approved",
  Rejected: "Rejected",
  Closed: "Closed",
} as const

export type EvidenceDecisionStatus =
  (typeof EvidenceDecisionStatus)[keyof typeof EvidenceDecisionStatus]

export const isEvidenceDecisionStatus = (
  value: unknown,
): value is EvidenceDecisionStatus =>
  typeof value === "string" &&
  (Object.values(EvidenceDecisionStatus) as string[]).includes(value)

// Calendar-year addition that survives leap days (Feb 29 + 1y → Feb 28).
export const addYears = (date: Date, years: number): Date => {
  const result = new Date(date.getTime())
  const day = result.getUTCDate()
  result.setUTCDate(1)
  result.setUTCFullYear(result.getUTCFullYear() + years)
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate()
  result.setUTCDate(Math.min(day, daysInTargetMonth))
  return result
}

export const evidenceExpiresAt = ({
  decisionStatus,
  decidedAt,
  accountClosedAt,
  retentionYears = DEFAULT_EVIDENCE_RETENTION_YEARS,
}: {
  decisionStatus: EvidenceDecisionStatus
  decidedAt?: Date | null
  accountClosedAt?: Date | null
  retentionYears?: number
}): Date | null => {
  switch (decisionStatus) {
    case EvidenceDecisionStatus.Approved:
      return accountClosedAt ? addYears(accountClosedAt, retentionYears) : null
    case EvidenceDecisionStatus.Rejected:
    case EvidenceDecisionStatus.Closed:
      return decidedAt ? addYears(decidedAt, retentionYears) : null
    default:
      return null
  }
}

export const isEvidenceExpired = ({
  expiresAt,
  now = new Date(),
}: {
  expiresAt: Date | null
  now?: Date
}): boolean => expiresAt !== null && expiresAt.getTime() <= now.getTime()

// When the account was closed, from the Galoy status history: the timestamp
// of the latest "closed" entry, but only while the account is still closed —
// a reopened account restarts the clock. Locked is not closure (an admin
// lock is reversible and the relationship continues).
export const getAccountClosedAt = (
  account: Pick<Account, "status" | "statusHistory">,
): Date | null => {
  if (account.status !== AccountStatus.Closed) return null

  const history = account.statusHistory ?? []
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]
    if (entry.status !== AccountStatus.Closed) continue
    if (!entry.updatedAt) return null
    const closedAt = new Date(entry.updatedAt)
    return Number.isNaN(closedAt.getTime()) ? null : closedAt
  }
  return null
}
