import { IdentitySource, UpgradeEvidenceType } from "@domain/accounts"
import {
  IdVerification,
  IdVerificationStatus,
  contentTypeFromFileKey,
  fromFrappeDatetime,
} from "@services/frappe/models/IdVerification"

const capturedAt = new Date("2026-09-01T12:00:00.000Z")

describe("IdVerification.fromEvidence().toErpnext()", () => {
  it("maps capture evidence to the ERPNext wire format", () => {
    const doc = IdVerification.fromEvidence({
      upgradeRequest: "AUR-0001",
      identitySource: IdentitySource.Capture,
      capturedAt,
      evidence: [
        {
          type: UpgradeEvidenceType.IdFront,
          fileKey: "id_documents/alice_front.JPG",
          sha256: "ab".repeat(32),
          documentType: "passport",
          issuingCountry: "JM",
        },
        { type: UpgradeEvidenceType.Selfie, fileKey: "id_documents/alice_selfie.png" },
      ],
    })

    expect(doc.toErpnext()).toEqual({
      doctype: "ID Verification",
      upgrade_request: "AUR-0001",
      status: IdVerificationStatus.ChecksPending,
      identity_source: "capture",
      bridge_customer_id: undefined,
      bridge_snapshot_json: undefined,
      evidence: [
        {
          name: undefined,
          evidence_type: "id_front",
          document_type: "passport",
          issuing_country: "JM",
          file_key: "id_documents/alice_front.JPG",
          sha256: "ab".repeat(32),
          content_type: "image/jpeg",
          captured_at: "2026-09-01 12:00:00",
          deleted_at: undefined,
        },
        {
          name: undefined,
          evidence_type: "selfie",
          document_type: undefined,
          issuing_country: undefined,
          file_key: "id_documents/alice_selfie.png",
          sha256: undefined,
          content_type: "image/png",
          captured_at: "2026-09-01 12:00:00",
          deleted_at: undefined,
        },
      ],
    })
  })

  it("maps a Bridge KYC identity with its snapshot", () => {
    const snapshot = {
      id: "cust_1",
      status: "active",
      updated_at: "2026-08-30T00:00:00Z",
      endorsements: [{ name: "base", status: "approved" }],
    }
    const doc = IdVerification.fromEvidence({
      upgradeRequest: "AUR-0002",
      identitySource: IdentitySource.BridgeKyc,
      bridgeCustomerId: "cust_1",
      bridgeSnapshot: snapshot,
      capturedAt,
      evidence: [{ type: UpgradeEvidenceType.BridgeKyc }],
    })

    const wire = doc.toErpnext()
    expect(wire.identity_source).toBe("bridge_kyc")
    expect(wire.bridge_customer_id).toBe("cust_1")
    expect(JSON.parse(wire.bridge_snapshot_json as string)).toEqual(snapshot)
    expect(wire.evidence).toEqual([
      expect.objectContaining({
        evidence_type: "bridge_kyc",
        file_key: undefined,
        content_type: undefined,
      }),
    ])
  })

  it("uses every evidence type's lowercase snake value", () => {
    const doc = IdVerification.fromEvidence({
      upgradeRequest: "AUR-0003",
      identitySource: IdentitySource.Capture,
      capturedAt,
      evidence: Object.values(UpgradeEvidenceType).map((type) => ({
        type,
        fileKey:
          type === UpgradeEvidenceType.BridgeKyc
            ? undefined
            : `id_documents/a_${type}.webp`,
      })),
    })
    expect(doc.toErpnext().evidence?.map((r) => r.evidence_type)).toEqual([
      "id_front",
      "id_back",
      "selfie",
      "liveness_frame",
      "business_registration",
      "trn",
      "proof_of_address",
      "bridge_kyc",
    ])
  })
})

describe("IdVerification.fromErpnext", () => {
  it("hydrates rows including child names and deleted_at", () => {
    const doc = IdVerification.fromErpnext({
      name: "IDV-0001",
      upgrade_request: "AUR-0001",
      status: "Checks pending",
      identity_source: "bridge_kyc",
      bridge_customer_id: "cust_1",
      bridge_snapshot_json: JSON.stringify({ id: "cust_1", status: "active" }),
      evidence: [
        {
          name: "row-1",
          evidence_type: "id_front",
          file_key: "id_documents/alice_front.jpg",
          captured_at: "2026-09-01 12:00:00.000000",
          deleted_at: null,
        },
        {
          name: "row-2",
          evidence_type: "selfie",
          file_key: "id_documents/alice_selfie.jpg",
          captured_at: "2026-09-01 12:00:00",
          deleted_at: "2033-09-02 00:00:00",
        },
      ],
    })

    expect(doc.name).toBe("IDV-0001")
    expect(doc.identitySource).toBe(IdentitySource.BridgeKyc)
    expect(doc.bridgeSnapshot).toEqual({ id: "cust_1", status: "active" })
    expect(doc.evidence).toEqual([
      expect.objectContaining({
        rowName: "row-1",
        type: UpgradeEvidenceType.IdFront,
        fileKey: "id_documents/alice_front.jpg",
        capturedAt: new Date("2026-09-01T12:00:00.000Z"),
        deletedAt: undefined,
      }),
      expect.objectContaining({
        rowName: "row-2",
        type: UpgradeEvidenceType.Selfie,
        deletedAt: new Date("2033-09-02T00:00:00.000Z"),
      }),
    ])
  })

  it("survives a corrupt snapshot and an unknown identity source", () => {
    const doc = IdVerification.fromErpnext({
      upgrade_request: "AUR-0001",
      status: "Checks pending",
      identity_source: "something-else",
      bridge_snapshot_json: "{not json",
    })
    expect(doc.identitySource).toBe(IdentitySource.Capture)
    expect(doc.bridgeSnapshot).toBeUndefined()
    expect(doc.evidence).toEqual([])
  })

  it("round-trips rows through evidenceRowToErpnext keeping the child name", () => {
    const [row] = IdVerification.fromErpnext({
      upgrade_request: "AUR-0001",
      status: "Checks pending",
      identity_source: "capture",
      evidence: [
        { name: "row-1", evidence_type: "selfie", file_key: "id_documents/a_s.jpg" },
      ],
    }).evidence

    expect(
      IdVerification.evidenceRowToErpnext({
        ...row,
        deletedAt: new Date("2033-01-01T00:00:00Z"),
      }),
    ).toEqual(
      expect.objectContaining({
        name: "row-1",
        evidence_type: "selfie",
        file_key: "id_documents/a_s.jpg",
        deleted_at: "2033-01-01 00:00:00",
      }),
    )
  })
})

describe("helpers", () => {
  it("contentTypeFromFileKey derives from the extension", () => {
    expect(contentTypeFromFileKey("id_documents/a_f.jpg")).toBe("image/jpeg")
    expect(contentTypeFromFileKey("id_documents/a_f.PNG")).toBe("image/png")
    expect(contentTypeFromFileKey("id_documents/a_f.webp")).toBe("image/webp")
    expect(contentTypeFromFileKey("id_documents/a_f")).toBeUndefined()
    expect(contentTypeFromFileKey("id_documents/a_f.exe")).toBeUndefined()
    expect(contentTypeFromFileKey(undefined)).toBeUndefined()
  })

  it("fromFrappeDatetime reads naive datetimes as UTC", () => {
    expect(fromFrappeDatetime("2026-09-01 12:00:00")).toEqual(
      new Date("2026-09-01T12:00:00.000Z"),
    )
    expect(fromFrappeDatetime("2026-09-01 12:00:00.123456")).toEqual(
      new Date("2026-09-01T12:00:00.123Z"),
    )
    expect(fromFrappeDatetime("")).toBeUndefined()
    expect(fromFrappeDatetime(null)).toBeUndefined()
    expect(fromFrappeDatetime("garbage")).toBeUndefined()
  })
})
