// In-memory stand-in for PaymentSplitExecutionsRepository that models the two
// properties the split pipeline relies on: the unique (triggerKey, ruleId)
// index and the atomic pending -> sending claim.
type Row = {
  id: string
  triggerKey: string
  ruleId: string
  walletId: string
  destinationWalletId: string
  currency: string
  triggerAmountMinor: string
  shareCents: number
  status: string
  attempts: number
  nextAttemptAt: Date
  lastError?: string
  createdAt: Date
  updatedAt: Date
}

export const createFakeExecutionsStore = () => {
  const rows = new Map<string, Row>()
  let seq = 0

  const repo = {
    insert: async (data: {
      triggerKey: string
      ruleId: string
      walletId: string
      destinationWalletId: string
      currency: string
      triggerAmountMinor: string
      shareCents: number
      status: string
      nextAttemptAt?: Date
      now?: Date
    }) => {
      const { now = new Date(), nextAttemptAt = now, ...fields } = data
      const dup = [...rows.values()].find(
        (r) => r.triggerKey === fields.triggerKey && r.ruleId === fields.ruleId,
      )
      if (dup) return { inserted: false as const }
      const id = `exec-${++seq}`
      rows.set(id, {
        ...fields,
        id,
        attempts: 0,
        nextAttemptAt,
        createdAt: now,
        updatedAt: now,
      })
      return { inserted: true as const, id }
    },
    claimNextDue: async (now: Date) => {
      const due = [...rows.values()]
        .filter((r) => r.status === "pending" && r.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())[0]
      if (!due) return null
      due.status = "sending"
      due.updatedAt = now
      return { ...due }
    },
    finishClaimed: async (
      id: string,
      update: {
        status: string
        attempts: number
        nextAttemptAt?: Date
        lastError?: string
        now?: Date
      },
    ) => {
      const row = rows.get(id)
      if (!row || row.status !== "sending") return false
      const { now = new Date(), ...fields } = update
      Object.assign(row, fields, { updatedAt: now })
      return true
    },
    markNextStaleUnknown: async (cutoff: Date, now: Date) => {
      const stale = [...rows.values()].find(
        (r) => r.status === "sending" && r.updatedAt < cutoff,
      )
      if (!stale) return null
      stale.status = "unknown"
      stale.updatedAt = now
      return { ...stale }
    },
  }

  return { rows, repo }
}
