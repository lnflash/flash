const mockGetIdVerificationList = jest.fn()
const mockGetIdVerificationById = jest.fn()
const mockGetUpgradeRequestDecision = jest.fn()
const mockUpdateIdVerificationEvidence = jest.fn()
const mockDeleteIdDocument = jest.fn()
const mockFindByUsername = jest.fn()

jest.mock("@config", () => {
  const actual = jest.requireActual("@config")
  return { ...actual, EVIDENCE_RETENTION_DRY_RUN: true, EVIDENCE_RETENTION_YEARS: 7 }
})

jest.mock("@services/logger", () => {
  // Built inside the factory: it runs when @config is first required, which
  // is before this file's own consts initialize.
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { baseLogger: { ...log, child: () => log } }
})

jest.mock("@services/mongoose", () => ({
  // plain function, not jest.fn: resetAllMocks would wipe the factory
  AccountsRepository: () => ({
    findByUsername: (...args: unknown[]) => mockFindByUsername(...args),
  }),
}))

jest.mock("@services/storage", () => ({
  deleteIdDocument: (...args: unknown[]) => mockDeleteIdDocument(...args),
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getIdVerificationList: (...args: unknown[]) => mockGetIdVerificationList(...args),
    getIdVerificationById: (...args: unknown[]) => mockGetIdVerificationById(...args),
    getUpgradeRequestDecision: (...args: unknown[]) =>
      mockGetUpgradeRequestDecision(...args),
    updateIdVerificationEvidence: (...args: unknown[]) =>
      mockUpdateIdVerificationEvidence(...args),
  },
}))

import { AccountStatus } from "@domain/accounts"
import { runEvidenceRetention } from "@app/accounts/run-evidence-retention"
import { IdVerificationQueryError } from "@services/frappe/errors"
import { IdVerification } from "@services/frappe/models/IdVerification"
import { baseLogger } from "@services/logger"
import { StorageError } from "@services/storage/errors"

const mockLog = baseLogger.child({}) as unknown as {
  info: jest.Mock
  warn: jest.Mock
  error: jest.Mock
}

const NOW = new Date("2036-01-01T00:00:00Z")

const idv = (name: string, rows: Array<Record<string, unknown>>) =>
  IdVerification.fromErpnext({
    name,
    upgrade_request: `AUR-${name}`,
    status: "Checks pending",
    identity_source: "capture",
    evidence: rows.map((row, i) => ({
      name: `${name}-row-${i}`,
      evidence_type: "id_front",
      file_key: `id_documents/alice_${name}_${i}.jpg`,
      captured_at: "2026-01-01 00:00:00",
      ...row,
    })),
  })

const decision = (status: string, decidedAt: string, username = "alice") => ({
  name: "AUR",
  username,
  status,
  decidedAt: new Date(decidedAt),
})

describe("runEvidenceRetention", () => {
  beforeEach(() => {
    // reset, not clear: queued mockResolvedValueOnce pages and per-test
    // implementations must not leak into the next test
    jest.resetAllMocks()
    mockUpdateIdVerificationEvidence.mockResolvedValue(undefined)
    mockDeleteIdDocument.mockImplementation(async ({ fileKey }) => ({ fileKey }))
  })

  it("dry run (the default): logs would-delete and touches neither storage nor ERPNext", async () => {
    mockGetIdVerificationList.mockResolvedValueOnce(["IDV-1"]).mockResolvedValueOnce([])
    mockGetIdVerificationById.mockResolvedValue(idv("IDV-1", [{}, {}]))
    mockGetUpgradeRequestDecision.mockResolvedValue(
      decision("Rejected", "2026-06-01T00:00:00Z"),
    )

    const summary = await runEvidenceRetention({ now: NOW })

    expect(summary).toEqual({
      dryRun: true,
      retentionYears: 7,
      scanned: 1,
      expired: 1,
      filesDeleted: 0,
      filesWouldDelete: 2,
      skipped: 0,
      errors: 0,
    })
    expect(mockDeleteIdDocument).not.toHaveBeenCalled()
    expect(mockUpdateIdVerificationEvidence).not.toHaveBeenCalled()
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ fileKey: "id_documents/alice_IDV-1_0.jpg" }),
      "evidence retention: would delete",
    )
  })

  it("live run: deletes expired files and stamps deleted_at on their rows only", async () => {
    mockGetIdVerificationList.mockResolvedValueOnce(["IDV-1"]).mockResolvedValueOnce([])
    mockGetIdVerificationById.mockResolvedValue(
      idv("IDV-1", [{}, { deleted_at: "2030-01-01 00:00:00" }, {}]),
    )
    mockGetUpgradeRequestDecision.mockResolvedValue(
      decision("Closed", "2026-06-01T00:00:00Z"),
    )

    const summary = await runEvidenceRetention({ now: NOW, dryRun: false })

    expect(summary).toEqual(
      expect.objectContaining({
        expired: 1,
        filesDeleted: 2,
        filesWouldDelete: 0,
        errors: 0,
      }),
    )
    expect(mockDeleteIdDocument).toHaveBeenCalledTimes(2)
    expect(mockDeleteIdDocument).toHaveBeenCalledWith({
      fileKey: "id_documents/alice_IDV-1_0.jpg",
    })
    expect(mockDeleteIdDocument).toHaveBeenCalledWith({
      fileKey: "id_documents/alice_IDV-1_2.jpg",
    })

    const [name, rows] = mockUpdateIdVerificationEvidence.mock.calls[0]
    expect(name).toBe("IDV-1")
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual(
      expect.objectContaining({ name: "IDV-1-row-0", deleted_at: "2036-01-01 00:00:00" }),
    )
    expect(rows[1]).toEqual(
      expect.objectContaining({ name: "IDV-1-row-1", deleted_at: "2030-01-01 00:00:00" }),
    )
    expect(rows[2]).toEqual(
      expect.objectContaining({ name: "IDV-1-row-2", deleted_at: "2036-01-01 00:00:00" }),
    )
  })

  it("does not expire Rejected evidence before the retention window", async () => {
    mockGetIdVerificationList.mockResolvedValueOnce(["IDV-1"]).mockResolvedValueOnce([])
    mockGetIdVerificationById.mockResolvedValue(idv("IDV-1", [{}]))
    mockGetUpgradeRequestDecision.mockResolvedValue(
      decision("Rejected", "2030-06-01T00:00:00Z"),
    )

    const summary = await runEvidenceRetention({ now: NOW, dryRun: false })

    expect(summary).toEqual(expect.objectContaining({ skipped: 1, expired: 0 }))
    expect(mockDeleteIdDocument).not.toHaveBeenCalled()
  })

  it("Approved: keeps evidence while the account is open, expires it 7y after closure", async () => {
    mockGetIdVerificationList
      .mockResolvedValueOnce(["IDV-open", "IDV-closed"])
      .mockResolvedValueOnce([])
    mockGetIdVerificationById.mockImplementation(async (name: string) => idv(name, [{}]))
    mockGetUpgradeRequestDecision.mockImplementation(async (name: string) =>
      decision(
        "Approved",
        "2026-01-01T00:00:00Z",
        name === "AUR-IDV-open" ? "open" : "closed",
      ),
    )
    mockFindByUsername.mockImplementation(async (username: string) =>
      username === "open"
        ? {
            status: AccountStatus.Active,
            statusHistory: [
              { status: AccountStatus.Active, updatedAt: new Date("2025-01-01") },
            ],
          }
        : {
            status: AccountStatus.Closed,
            statusHistory: [
              { status: AccountStatus.Active, updatedAt: new Date("2025-01-01") },
              {
                status: AccountStatus.Closed,
                updatedAt: new Date("2028-01-01T00:00:00Z"),
              },
            ],
          },
    )

    const summary = await runEvidenceRetention({ now: NOW, dryRun: false })

    expect(summary).toEqual(
      expect.objectContaining({ scanned: 2, skipped: 1, expired: 1 }),
    )
    expect(mockDeleteIdDocument).toHaveBeenCalledTimes(1)
    expect(mockDeleteIdDocument).toHaveBeenCalledWith({
      fileKey: "id_documents/alice_IDV-closed_0.jpg",
    })
  })

  it("skips Pending requests and records with nothing left to delete", async () => {
    mockGetIdVerificationList
      .mockResolvedValueOnce(["IDV-pending", "IDV-done"])
      .mockResolvedValueOnce([])
    mockGetIdVerificationById.mockImplementation(async (name: string) =>
      name === "IDV-done"
        ? idv(name, [{ deleted_at: "2030-01-01 00:00:00" }])
        : idv(name, [{}]),
    )
    mockGetUpgradeRequestDecision.mockResolvedValue(
      decision("Pending", "2026-01-01T00:00:00Z"),
    )

    const summary = await runEvidenceRetention({ now: NOW, dryRun: false })

    expect(summary).toEqual(
      expect.objectContaining({ scanned: 2, skipped: 2, expired: 0 }),
    )
    expect(mockGetUpgradeRequestDecision).toHaveBeenCalledTimes(1)
    expect(mockDeleteIdDocument).not.toHaveBeenCalled()
  })

  it("counts per-record failures and keeps going", async () => {
    mockGetIdVerificationList
      .mockResolvedValueOnce(["IDV-bad", "IDV-good"])
      .mockResolvedValueOnce([])
    mockGetIdVerificationById.mockImplementation(async (name: string) =>
      name === "IDV-bad" ? new IdVerificationQueryError("gone") : idv(name, [{}]),
    )
    mockGetUpgradeRequestDecision.mockResolvedValue(
      decision("Rejected", "2026-01-01T00:00:00Z"),
    )

    const summary = await runEvidenceRetention({ now: NOW, dryRun: false })

    expect(summary).toEqual(
      expect.objectContaining({ scanned: 2, errors: 1, expired: 1 }),
    )
    expect(mockDeleteIdDocument).toHaveBeenCalledTimes(1)
  })

  it("a storage delete failure leaves that row unstamped and is counted", async () => {
    mockGetIdVerificationList.mockResolvedValueOnce(["IDV-1"]).mockResolvedValueOnce([])
    mockGetIdVerificationById.mockResolvedValue(idv("IDV-1", [{}, {}]))
    mockGetUpgradeRequestDecision.mockResolvedValue(
      decision("Rejected", "2026-01-01T00:00:00Z"),
    )
    mockDeleteIdDocument
      .mockResolvedValueOnce(new StorageError("nope"))
      .mockResolvedValueOnce({ fileKey: "id_documents/alice_IDV-1_1.jpg" })

    const summary = await runEvidenceRetention({ now: NOW, dryRun: false })

    expect(summary).toEqual(expect.objectContaining({ filesDeleted: 1, errors: 1 }))
    const [, rows] = mockUpdateIdVerificationEvidence.mock.calls[0]
    expect(rows[0].deleted_at).toBeUndefined()
    expect(rows[1].deleted_at).toBe("2036-01-01 00:00:00")
  })

  it("pages through the listing", async () => {
    mockGetIdVerificationList
      .mockResolvedValueOnce(["IDV-1", "IDV-2"])
      .mockResolvedValueOnce(["IDV-3"])
    mockGetIdVerificationById.mockImplementation(async (name: string) => idv(name, [{}]))
    mockGetUpgradeRequestDecision.mockResolvedValue(
      decision("Rejected", "2030-01-01T00:00:00Z"),
    )

    const summary = await runEvidenceRetention({ now: NOW, pageSize: 2 })

    expect(summary).toEqual(expect.objectContaining({ scanned: 3 }))
    expect(mockGetIdVerificationList).toHaveBeenNthCalledWith(1, {
      limitStart: 0,
      pageLength: 2,
    })
    expect(mockGetIdVerificationList).toHaveBeenNthCalledWith(2, {
      limitStart: 2,
      pageLength: 2,
    })
    expect(mockGetIdVerificationList).toHaveBeenCalledTimes(2)
  })

  it("fails the run on a listing error", async () => {
    mockGetIdVerificationList.mockResolvedValue(new IdVerificationQueryError("down"))
    expect(await runEvidenceRetention({ now: NOW })).toBeInstanceOf(
      IdVerificationQueryError,
    )
  })
})
