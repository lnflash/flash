import { informDedupTtlMs } from "./dedup-key"

const seenAt = new Map<string, number>()

/**
 * Returns true when Slack/Discord should fire for this dedup key (first within TTL).
 * Subsequent duplicates within the TTL are suppressed.
 */
export const claimInformSlot = (dedupKey: string, nowMs = Date.now()): boolean => {
  const ttlMs = informDedupTtlMs(dedupKey)
  const lastSentAt = seenAt.get(dedupKey)

  if (lastSentAt !== undefined && nowMs - lastSentAt < ttlMs) {
    return false
  }

  seenAt.set(dedupKey, nowMs)
  pruneExpired(nowMs)
  return true
}

const pruneExpired = (nowMs: number): void => {
  if (seenAt.size < 500) return

  for (const [key, sentAt] of seenAt) {
    if (nowMs - sentAt >= informDedupTtlMs(key)) {
      seenAt.delete(key)
    }
  }
}

/** Test helper — clears the in-process inform dedup cache. */
export const resetInformDedup = (): void => {
  seenAt.clear()
}
