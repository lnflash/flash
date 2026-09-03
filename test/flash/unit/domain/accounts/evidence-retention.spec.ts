import {
  AccountStatus,
  DEFAULT_EVIDENCE_RETENTION_YEARS,
  EvidenceDecisionStatus,
  addYears,
  evidenceExpiresAt,
  getAccountClosedAt,
  isEvidenceExpired,
} from "@domain/accounts"

const d = (iso: string) => new Date(iso)

describe("addYears", () => {
  it("adds calendar years in UTC", () => {
    expect(addYears(d("2026-03-15T10:00:00Z"), 7).toISOString()).toBe(
      "2033-03-15T10:00:00.000Z",
    )
  })

  it("clamps Feb 29 to Feb 28 in a non-leap target year", () => {
    expect(addYears(d("2024-02-29T00:00:00Z"), 1).toISOString()).toBe(
      "2025-02-28T00:00:00.000Z",
    )
  })
})

describe("evidenceExpiresAt", () => {
  const decidedAt = d("2026-01-10T00:00:00Z")

  it("defaults to 7 years", () => {
    expect(DEFAULT_EVIDENCE_RETENTION_YEARS).toBe(7)
    expect(
      evidenceExpiresAt({ decisionStatus: EvidenceDecisionStatus.Rejected, decidedAt }),
    ).toEqual(d("2033-01-10T00:00:00Z"))
  })

  it("Rejected and Closed expire retentionYears after the decision", () => {
    for (const decisionStatus of [
      EvidenceDecisionStatus.Rejected,
      EvidenceDecisionStatus.Closed,
    ]) {
      expect(evidenceExpiresAt({ decisionStatus, decidedAt, retentionYears: 2 })).toEqual(
        d("2028-01-10T00:00:00Z"),
      )
    }
  })

  it("Approved expires retentionYears after the account closes", () => {
    expect(
      evidenceExpiresAt({
        decisionStatus: EvidenceDecisionStatus.Approved,
        decidedAt,
        accountClosedAt: d("2030-06-01T00:00:00Z"),
        retentionYears: 7,
      }),
    ).toEqual(d("2037-06-01T00:00:00Z"))
  })

  it("Approved never expires while the account is open", () => {
    expect(
      evidenceExpiresAt({
        decisionStatus: EvidenceDecisionStatus.Approved,
        decidedAt,
        accountClosedAt: null,
      }),
    ).toBeNull()
  })

  it("Pending never expires; a decision without a date never expires", () => {
    expect(
      evidenceExpiresAt({ decisionStatus: EvidenceDecisionStatus.Pending, decidedAt }),
    ).toBeNull()
    expect(
      evidenceExpiresAt({
        decisionStatus: EvidenceDecisionStatus.Rejected,
        decidedAt: null,
      }),
    ).toBeNull()
  })
})

describe("isEvidenceExpired", () => {
  it("is true at or after the expiry instant", () => {
    const expiresAt = d("2033-01-10T00:00:00Z")
    expect(isEvidenceExpired({ expiresAt, now: d("2033-01-09T23:59:59Z") })).toBe(false)
    expect(isEvidenceExpired({ expiresAt, now: expiresAt })).toBe(true)
    expect(isEvidenceExpired({ expiresAt: null, now: d("2099-01-01T00:00:00Z") })).toBe(
      false,
    )
  })
})

describe("getAccountClosedAt", () => {
  const history = (
    entries: Array<{ status: AccountStatus; updatedAt?: Date }>,
  ): Pick<Account, "status" | "statusHistory"> => ({
    status: entries[entries.length - 1].status,
    statusHistory: entries,
  })

  it("returns the updatedAt of the latest closed entry when the account is closed", () => {
    const account = history([
      { status: AccountStatus.Active, updatedAt: d("2025-01-01T00:00:00Z") },
      { status: AccountStatus.Closed, updatedAt: d("2026-02-02T00:00:00Z") },
    ])
    expect(getAccountClosedAt(account)).toEqual(d("2026-02-02T00:00:00Z"))
  })

  it("returns null while the account is open, locked, or was reopened", () => {
    expect(
      getAccountClosedAt(
        history([{ status: AccountStatus.Active, updatedAt: d("2025-01-01") }]),
      ),
    ).toBeNull()
    expect(
      getAccountClosedAt(
        history([{ status: AccountStatus.Locked, updatedAt: d("2025-01-01") }]),
      ),
    ).toBeNull()
    expect(
      getAccountClosedAt(
        history([
          { status: AccountStatus.Closed, updatedAt: d("2025-01-01") },
          { status: AccountStatus.Active, updatedAt: d("2025-06-01") },
        ]),
      ),
    ).toBeNull()
  })

  it("returns null when the closed entry has no timestamp", () => {
    expect(getAccountClosedAt(history([{ status: AccountStatus.Closed }]))).toBeNull()
  })
})
