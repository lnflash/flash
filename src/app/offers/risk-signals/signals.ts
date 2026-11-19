// Cash-out risk signals (ENG-889): pure matching and formatting.
//
// Flag only. Nothing here may block or fail a cash-out; the lines produced
// end up in the internal Cashout Initiated email and on the ERPNext Cashout
// record for the staff member who pays the cash-out by hand.

import { BridgeTransferRequestStatus } from "@services/frappe/models/BridgeTransferRequest"

export const NEW_ACCOUNT_DAYS = 30
export const DEPOSIT_WINDOW_HOURS = 72

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

export const RISK_SIGNALS_UNAVAILABLE_LINE =
  "Risk signals unavailable (lookup failed). Check this account by hand before paying."
export const DEPOSIT_SIGNALS_UNAVAILABLE_LINE =
  "Bridge deposit signals unavailable (lookup failed). Check this account's deposits by hand before paying."

export type RecentBridgeDeposit = {
  requestId: string
  amount?: string
  currency?: string
  status?: string
  // When Flash last saw the deposit (Bridge Transfer Request last_seen_at).
  // On a Completed row this is when the credit landed.
  seenAt?: Date
  originatorName?: string
  bankName?: string
  paymentRail?: string
}

export type DepositSignals =
  | {
      available: true
      deposits: RecentBridgeDeposit[]
      // Deposits whose originator name matches none of the holder names.
      mismatched: RecentBridgeDeposit[]
      holderNames: string[]
      minutesSinceLastCredit?: number
    }
  | { available: false }

export type CashoutRiskSignals =
  | {
      available: true
      accountAgeDays?: number
      newAccount: boolean
      deposits: DepositSignals
    }
  | { available: false }

// ---------- names ----------

export const nameTokens = (name: string | undefined | null): string[] => {
  if (typeof name !== "string") return []
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0)
}

// Two names match when, after normalizing case, accents, whitespace and
// punctuation and dropping single-letter initials, the smaller set of name
// parts is contained in the larger one ("TAEDO D BIGGS" matches "Taedo
// Biggs", "Biggs, Taedo" matches "Taedo Biggs"). A containment must cover at
// least two name parts so a shared surname alone is not a match; one-part
// names match only exactly. A missing or empty name never matches.
export const namesMatch = (
  a: string | undefined | null,
  b: string | undefined | null,
): boolean => {
  const ta = new Set(nameTokens(a).filter((t) => t.length > 1))
  const tb = new Set(nameTokens(b).filter((t) => t.length > 1))
  if (ta.size === 0 || tb.size === 0) return false

  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  const contained = [...small].every((t) => large.has(t))
  if (!contained) return false
  if (small.size >= 2) return true
  return small.size === large.size
}

// Known holder names, blanks dropped and duplicates (after normalizing)
// removed, first spelling kept.
export const uniqueNames = (names: string[]): string[] => {
  const seen = new Set<string>()
  return names.filter((name) => {
    const key = nameTokens(name).join(" ")
    if (key === "" || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const matchesAnyHolderName = (
  originatorName: string | undefined | null,
  holderNames: string[],
): boolean => holderNames.some((holder) => namesMatch(originatorName, holder))

// A deposit is a mismatch only when both sides are known: an originator name
// is recorded and at least one holder name is known to compare it with.
export const isNameMismatch = (
  deposit: RecentBridgeDeposit,
  holderNames: string[],
): boolean => {
  if (nameTokens(deposit.originatorName).length === 0) return false
  const knownHolders = uniqueNames(holderNames)
  if (knownHolders.length === 0) return false
  return !matchesAnyHolderName(deposit.originatorName, knownHolders)
}

// ---------- account age ----------

export const accountAgeDays = (createdAt: Date | undefined, now: Date) => {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    return undefined
  }
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS))
}

export const isNewAccount = (ageDays: number | undefined): boolean =>
  ageDays !== undefined && ageDays < NEW_ACCOUNT_DAYS

// ---------- deposits ----------

export const depositWindowStart = (now: Date) =>
  new Date(now.getTime() - DEPOSIT_WINDOW_HOURS * 60 * MINUTE_MS)

export const inDepositWindow = (seenAt: Date | undefined, now: Date): boolean => {
  if (!(seenAt instanceof Date) || Number.isNaN(seenAt.getTime())) return false
  return seenAt.getTime() >= depositWindowStart(now).getTime()
}

// Frappe datetimes written by toFrappeDatetime are naive UTC
// ("YYYY-MM-DD HH:MM:SS").
export const parseFrappeUtc = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined
  const date = new Date(`${value.trim().replace(" ", "T")}Z`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

const asText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

// The deposit webhook stores the whole Bridge event as raw_payload_json; a
// virtual account deposit carries the sender under event_object.source.
// Bridge names the sender `originator_name` on a wire and `sender_name` on
// ACH, FedNow, RTP and SEPA; only a wire carries `bank_name`, so ACH, FedNow
// and RTP fall back to the sending bank's routing number. Bad or missing JSON
// yields no source fields.
export const parseDepositSource = (
  rawPayloadJson: unknown,
): { originatorName?: string; bankName?: string; paymentRail?: string } => {
  let payload: unknown = rawPayloadJson
  if (typeof rawPayloadJson === "string") {
    try {
      payload = JSON.parse(rawPayloadJson)
    } catch {
      return {}
    }
  }
  if (!payload || typeof payload !== "object") return {}
  const eventObject = (payload as { event_object?: unknown }).event_object
  if (!eventObject || typeof eventObject !== "object") return {}
  const source = (eventObject as { source?: unknown }).source
  if (!source || typeof source !== "object") return {}
  const s = source as Record<string, unknown>
  const routingNumber = asText(s.sender_bank_routing_number)
  return {
    originatorName: asText(s.originator_name) ?? asText(s.sender_name),
    bankName:
      asText(s.bank_name) ?? (routingNumber ? `routing ${routingNumber}` : undefined),
    paymentRail: asText(s.payment_rail),
  }
}

export const toRecentBridgeDeposit = (row: {
  request_id?: string | null
  status?: string | null
  amount?: number | string | null
  currency?: string | null
  last_seen_at?: string | null
  raw_payload_json?: string | null
}): RecentBridgeDeposit => ({
  requestId: asText(row.request_id) ?? "unknown",
  status: asText(row.status),
  amount: asText(row.amount),
  currency: asText(row.currency),
  seenAt: parseFrappeUtc(row.last_seen_at),
  ...parseDepositSource(row.raw_payload_json),
})

export const buildDepositSignals = ({
  deposits,
  holderNames,
  now,
}: {
  deposits: RecentBridgeDeposit[]
  holderNames: string[]
  now: Date
}): DepositSignals => {
  const recent = deposits
    .filter((d) => inDepositWindow(d.seenAt, now))
    .sort((x, y) => (y.seenAt?.getTime() ?? 0) - (x.seenAt?.getTime() ?? 0))

  const lastCredit = recent.find(
    (d) => d.status === BridgeTransferRequestStatus.Completed && d.seenAt,
  )
  const minutesSinceLastCredit = lastCredit?.seenAt
    ? Math.max(0, Math.floor((now.getTime() - lastCredit.seenAt.getTime()) / MINUTE_MS))
    : undefined

  return {
    available: true,
    deposits: recent,
    mismatched: recent.filter((d) => isNameMismatch(d, holderNames)),
    holderNames: uniqueNames(holderNames),
    minutesSinceLastCredit,
  }
}

export const hasRiskWarning = (signals: CashoutRiskSignals): boolean => {
  if (!signals.available) return true
  if (signals.newAccount) return true
  if (!signals.deposits.available) return true
  return signals.deposits.mismatched.length > 0
}

// ---------- formatting ----------

const formatUtc = (date: Date | undefined): string => {
  if (!date) return "time unknown"
  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

const quote = (value: string | undefined) => (value ? `"${value}"` : "not recorded")

const formatDeposit = (d: RecentBridgeDeposit): string => {
  const amount = [d.amount ?? "amount unknown", d.currency?.toUpperCase()]
    .filter(Boolean)
    .join(" ")
  const parts = [
    amount,
    d.status ?? "status unknown",
    formatUtc(d.seenAt),
    `sender ${quote(d.originatorName)}`,
  ]
  const via = [d.paymentRail, d.bankName].filter(Boolean).join(", ")
  if (via) parts.push(via)
  return `- ${parts.join(", ")}`
}

const formatMinutes = (minutes: number): string =>
  minutes < 1 ? "under 1 min" : `${minutes} min`

// Plain-text lines, warnings first. Shared by the email (text and HTML) and
// the ERPNext Cashout remarks so staff read the same thing in both places.
export const formatRiskLines = (signals: CashoutRiskSignals): string[] => {
  if (!signals.available) return [RISK_SIGNALS_UNAVAILABLE_LINE]

  const warnings: string[] = []
  const details: string[] = []
  const { deposits } = signals

  if (deposits.available) {
    const holders = uniqueNames(deposits.holderNames)
    for (const d of deposits.mismatched) {
      warnings.push(
        `WARNING: deposit sender name does not match the account holder. Sender ${quote(
          d.originatorName,
        )}, holder ${holders.map((h) => `"${h}"`).join(" or ")}.`,
      )
    }
  }

  if (signals.newAccount && signals.accountAgeDays !== undefined) {
    warnings.push(
      `WARNING: new account, ${signals.accountAgeDays} days old (under ${NEW_ACCOUNT_DAYS} days).`,
    )
  }

  details.push(
    signals.accountAgeDays === undefined
      ? "Account age: unknown"
      : `Account age: ${signals.accountAgeDays} days`,
  )

  if (!deposits.available) {
    details.push(DEPOSIT_SIGNALS_UNAVAILABLE_LINE)
  } else {
    details.push(
      `Bridge deposits in the last ${DEPOSIT_WINDOW_HOURS} hours: ${deposits.deposits.length}`,
    )
    for (const d of deposits.deposits) details.push(formatDeposit(d))
    if (deposits.deposits.length > 0) {
      if (uniqueNames(deposits.holderNames).length === 0) {
        details.push("Account holder name unknown, sender names not compared.")
      }
      details.push(
        deposits.minutesSinceLastCredit === undefined
          ? "Last deposit credit: none credited in this window"
          : `Last deposit credit: ${formatMinutes(
              deposits.minutesSinceLastCredit,
            )} before this cash-out`,
      )
    }
  }

  return [...warnings, ...details]
}

// Text for the ERPNext Cashout `remarks` field.
export const formatRiskRemarks = (signals: CashoutRiskSignals): string =>
  [RISK_REMARKS_HEADER, ...formatRiskLines(signals)].join("\n")

export const RISK_REMARKS_HEADER = "Risk signals (flag only, nothing was blocked):"
