const mockFindAccountById = jest.fn()
const mockFindUserById = jest.fn()
const mockGetIdentity = jest.fn()
const mockGetUpgradeRequestList = jest.fn()
const mockCloseUpgradeRequests = jest.fn()
const mockPostUpgradeRequest = jest.fn()
const mockPostIdVerification = jest.fn()
const mockGetCustomer = jest.fn()

jest.mock("@config", () => {
  const actual = jest.requireActual("@config")
  return { ...actual, UPGRADE_EVIDENCE_STRICT: false }
})

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => ({}) },
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/mongoose", () => ({
  UsersRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindUserById(...args),
  })),
  AccountsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindAccountById(...args),
  })),
}))

jest.mock("@services/kratos", () => ({
  IdentityRepository: jest.fn(() => ({
    getIdentity: (...args: unknown[]) => mockGetIdentity(...args),
  })),
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getAccountUpgradeRequestList: (...args: unknown[]) =>
      mockGetUpgradeRequestList(...args),
    closeAccountUpgradeRequests: (...args: unknown[]) =>
      mockCloseUpgradeRequests(...args),
    postUpgradeRequest: (...args: unknown[]) => mockPostUpgradeRequest(...args),
    postIdVerification: (...args: unknown[]) => mockPostIdVerification(...args),
  },
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: {
    getCustomer: (...args: unknown[]) => mockGetCustomer(...args),
  },
}))

import { AccountLevel, UpgradeEvidenceType } from "@domain/accounts"
import { ValidationError } from "@domain/shared"
import { createUpgradeRequest } from "@app/accounts/business-account-upgrade-request"
import {
  prepareUpgradeEvidence,
  recordIdVerification,
} from "@app/accounts/record-id-verification"
import { IdVerificationCreateError } from "@services/frappe/errors"
import { IdVerification } from "@services/frappe/models/IdVerification"
import { baseLogger } from "@services/logger"

const userId = "11111111-1111-4111-8111-111111111111" as UserId
const accountId = "64df1a2b3c4d5e6f78901234" as AccountId
const phone = "+18765550100" as PhoneNumber
const own = (file: string) => `id_documents/alice/${file}`

const baseAccount = {
  id: accountId,
  kratosUserId: userId,
  username: "alice",
  level: AccountLevel.One,
  status: "active",
}

const input = {
  level: AccountLevel.Two,
  accountId,
  fullName: "Alice Applicant",
  address: {
    title: "Home",
    line1: "1 Main St",
    city: "Kingston",
    state: "St. Andrew",
    country: "Jamaica",
  },
  terminalsRequested: 0,
  idDocument: "",
}

const postedUpgradeRequest = () => mockPostUpgradeRequest.mock.calls[0][0]
const postedIdVerification = (): IdVerification => mockPostIdVerification.mock.calls[0][0]

describe("createUpgradeRequest with evidence", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindAccountById.mockResolvedValue(baseAccount)
    mockFindUserById.mockResolvedValue({ id: userId, phone })
    mockGetIdentity.mockResolvedValue({ email: "alice@example.com" })
    mockGetUpgradeRequestList.mockResolvedValue([])
    mockCloseUpgradeRequests.mockResolvedValue(undefined)
    mockPostUpgradeRequest.mockResolvedValue({ name: "AUR-0001" })
    mockPostIdVerification.mockResolvedValue({ name: "IDV-0001" })
  })

  it("legacy idDocument only: unchanged upgrade request + one ID_FRONT evidence row", async () => {
    const result = await createUpgradeRequest(accountId, {
      ...input,
      idDocument: "doc-1",
    })

    expect(result).toEqual({ id: "AUR-0001", status: "Pending" })
    expect(postedUpgradeRequest().idDocument).toBe("doc-1")

    const idv = postedIdVerification()
    expect(idv.upgradeRequest).toBe("AUR-0001")
    expect(idv.identitySource).toBe("capture")
    expect(idv.evidence).toEqual([
      expect.objectContaining({ type: UpgradeEvidenceType.IdFront, fileKey: "doc-1" }),
    ])
    expect(mockGetCustomer).not.toHaveBeenCalled()
  })

  it("structured evidence: legacy id_document carries the first ID_FRONT key", async () => {
    await createUpgradeRequest(accountId, {
      ...input,
      evidence: [
        { type: UpgradeEvidenceType.Selfie, fileKey: own("selfie.jpg") },
        {
          type: UpgradeEvidenceType.IdFront,
          fileKey: own("front.jpg"),
          sha256: "f".repeat(64),
        },
        { type: UpgradeEvidenceType.IdBack, fileKey: own("back.jpg") },
      ],
    })

    expect(postedUpgradeRequest().idDocument).toBe(own("front.jpg"))
    expect(postedIdVerification().evidence.map((r) => r.type)).toEqual([
      UpgradeEvidenceType.Selfie,
      UpgradeEvidenceType.IdFront,
      UpgradeEvidenceType.IdBack,
    ])
  })

  it("rejects evidence pointing at another account's upload before touching ERPNext", async () => {
    const result = await createUpgradeRequest(accountId, {
      ...input,
      evidence: [
        { type: UpgradeEvidenceType.IdFront, fileKey: "id_documents/bob/front.jpg" },
      ],
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(mockGetUpgradeRequestList).not.toHaveBeenCalled()
    expect(mockPostUpgradeRequest).not.toHaveBeenCalled()
  })

  // Regression: `alice` must not be able to claim `alice_smith`'s upload by
  // exploiting the shared `_`/username-boundary ambiguity (see
  // domain/accounts/upgrade-evidence.spec.ts for the unit-level pin).
  it("rejects an upload whose username merely starts with this account's username", async () => {
    const result = await createUpgradeRequest(accountId, {
      ...input,
      evidence: [
        {
          type: UpgradeEvidenceType.IdFront,
          fileKey: "id_documents/alice_smith_front.jpg",
        },
      ],
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(mockGetUpgradeRequestList).not.toHaveBeenCalled()
    expect(mockPostUpgradeRequest).not.toHaveBeenCalled()
  })

  it("rejects a BRIDGE_KYC row when the account's Bridge KYC is not approved", async () => {
    mockFindAccountById.mockResolvedValue({
      ...baseAccount,
      bridgeKycStatus: "under_review",
    })

    const result = await createUpgradeRequest(accountId, {
      ...input,
      evidence: [{ type: UpgradeEvidenceType.BridgeKyc }],
    })

    expect(result).toBeInstanceOf(ValidationError)
    expect(mockPostUpgradeRequest).not.toHaveBeenCalled()
  })

  describe("Bridge KYC approved", () => {
    const bridgeAccount = {
      ...baseAccount,
      bridgeKycStatus: "approved",
      bridgeCustomerId: "cust_1",
    }
    const customer = {
      id: "cust_1",
      type: "individual",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-30T00:00:00Z",
      first_name: "Alice",
      last_name: "Applicant",
      email: "alice@example.com",
      endorsements: [{ name: "base", status: "approved" }],
    }

    beforeEach(() => {
      mockFindAccountById.mockResolvedValue(bridgeAccount)
      mockGetCustomer.mockResolvedValue(customer)
    })

    it("snapshots only id/status/updated_at/endorsements when a BRIDGE_KYC row is sent", async () => {
      await createUpgradeRequest(accountId, {
        ...input,
        evidence: [{ type: UpgradeEvidenceType.BridgeKyc }],
      })

      expect(mockGetCustomer).toHaveBeenCalledWith("cust_1")
      const idv = postedIdVerification()
      expect(idv.identitySource).toBe("bridge_kyc")
      expect(idv.bridgeCustomerId).toBe("cust_1")
      expect(idv.bridgeSnapshot).toEqual({
        id: "cust_1",
        status: "active",
        updated_at: "2026-08-30T00:00:00Z",
        endorsements: [{ name: "base", status: "approved" }],
      })
      expect(JSON.stringify(idv.toErpnext())).not.toContain("alice@example.com")
    })

    it("uses Bridge as the identity source when no evidence at all was sent", async () => {
      await createUpgradeRequest(accountId, input)

      expect(mockGetCustomer).toHaveBeenCalledWith("cust_1")
      const idv = postedIdVerification()
      expect(idv.identitySource).toBe("bridge_kyc")
      expect(idv.evidence).toEqual([
        expect.objectContaining({ type: UpgradeEvidenceType.BridgeKyc }),
      ])
      expect(postedUpgradeRequest().idDocument).toBe("")
    })

    it("does not snapshot for a capture-only submission", async () => {
      await createUpgradeRequest(accountId, {
        ...input,
        evidence: [{ type: UpgradeEvidenceType.IdFront, fileKey: own("front.jpg") }],
      })

      expect(mockGetCustomer).not.toHaveBeenCalled()
      expect(postedIdVerification().identitySource).toBe("capture")
    })

    it("a failed snapshot does not block the request", async () => {
      mockGetCustomer.mockRejectedValue(new Error("bridge down"))

      const result = await createUpgradeRequest(accountId, {
        ...input,
        evidence: [{ type: UpgradeEvidenceType.BridgeKyc }],
      })

      expect(result).toEqual({ id: "AUR-0001", status: "Pending" })
      const idv = postedIdVerification()
      expect(idv.identitySource).toBe("bridge_kyc")
      expect(idv.bridgeCustomerId).toBe("cust_1")
      expect(idv.bridgeSnapshot).toBeUndefined()
      expect(baseLogger.warn).toHaveBeenCalled()
    })
  })

  it("a failed ID Verification write is logged at warn and does not fail the request", async () => {
    mockPostIdVerification.mockResolvedValue(new IdVerificationCreateError("no doctype"))

    const result = await createUpgradeRequest(accountId, {
      ...input,
      idDocument: "doc-1",
    })

    expect(result).toEqual({ id: "AUR-0001", status: "Pending" })
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ upgradeRequestName: "AUR-0001", accountId }),
      "ID Verification not recorded for upgrade request; continuing",
    )
    expect(baseLogger.error).not.toHaveBeenCalled()
  })

  it("does not write an ID Verification when the upgrade request itself fails", async () => {
    mockPostUpgradeRequest.mockResolvedValue(new Error("erp down"))

    const result = await createUpgradeRequest(accountId, {
      ...input,
      idDocument: "doc-1",
    })

    expect(result).toBeInstanceOf(Error)
    expect(mockPostIdVerification).not.toHaveBeenCalled()
  })
})

describe("prepareUpgradeEvidence strict mode", () => {
  const account = { username: "alice" as Username, bridgeKycStatus: undefined }

  it("strict requires ID_FRONT + SELFIE for level 2", () => {
    expect(
      prepareUpgradeEvidence({
        account,
        level: AccountLevel.Two,
        idDocument: "doc-1",
        strict: true,
      }),
    ).toBeInstanceOf(ValidationError)

    const ok = prepareUpgradeEvidence({
      account,
      level: AccountLevel.Two,
      strict: true,
      evidence: [
        { type: UpgradeEvidenceType.IdFront, fileKey: own("front.jpg") },
        { type: UpgradeEvidenceType.Selfie, fileKey: own("selfie.jpg") },
      ],
    })
    expect(ok).not.toBeInstanceOf(Error)
  })

  it("non-strict (the default from config in this test) accepts the legacy key alone", () => {
    const result = prepareUpgradeEvidence({
      account,
      level: AccountLevel.Two,
      idDocument: "doc-1",
    })
    expect(result).not.toBeInstanceOf(Error)
  })
})

describe("recordIdVerification", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns the created name", async () => {
    mockPostIdVerification.mockResolvedValue({ name: "IDV-9" })
    const result = await recordIdVerification({
      upgradeRequestName: "AUR-9",
      account: { id: accountId, bridgeCustomerId: undefined },
      evidence: [{ type: UpgradeEvidenceType.IdFront, fileKey: own("f.jpg") }],
      bridgeKycApproved: false,
    })
    expect(result).toEqual({ name: "IDV-9" })
  })
})
