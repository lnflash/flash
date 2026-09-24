jest.mock("@services/logger", () => ({
  baseLogger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

import { IdentitySource, UpgradeEvidenceType } from "@domain/accounts"
import {
  FRAPPE_COUNTRY_BY_ISO2,
  IDENTITY_DOCUMENT_TYPE_CODES,
  IdVerification,
  IdVerificationStatus,
  contentTypeFromFileKey,
  fromFrappeDatetime,
  toFrappeCountry,
  toIdentityDocumentTypeCode,
} from "@services/frappe/models/IdVerification"
import { baseLogger } from "@services/logger"

const capturedAt = new Date("2026-09-01T12:00:00.000Z")

const toErpnextRow = (row: {
  documentType?: string
  issuingCountry?: string
  rowName?: string
}) =>
  IdVerification.evidenceRowToErpnext({
    type: UpgradeEvidenceType.IdFront,
    fileKey: "id_documents/alice/front.jpg",
    sha256: "ab".repeat(32),
    ...row,
  })

describe("evidence link mapping (document_type / issuing_country)", () => {
  beforeEach(() => {
    ;(baseLogger.warn as jest.Mock).mockClear()
  })

  // Exactly the rows admin_panel/setup.py IDENTITY_DOCUMENT_TYPES seeds.
  it("mirrors the seeded registry codes per country", () => {
    expect(IDENTITY_DOCUMENT_TYPE_CODES).toEqual({
      JM: {
        passport: "JM_PASSPORT",
        drivers_licence: "JM_DRIVERS_LICENCE",
        voter_id: "JM_VOTER_ID",
        national_id: "JM_NIDS",
      },
      KY: { passport: "KY_PASSPORT", drivers_licence: "KY_DRIVERS_LICENCE" },
      TT: {
        passport: "TT_PASSPORT",
        national_id: "TT_NATIONAL_ID",
        drivers_licence: "TT_DRIVERS_PERMIT",
      },
      BB: {
        passport: "BB_PASSPORT",
        national_id: "BB_NATIONAL_ID",
        drivers_licence: "BB_DRIVERS_LICENCE",
      },
      BS: {
        passport: "BS_PASSPORT",
        drivers_licence: "BS_DRIVERS_LICENCE",
        voter_id: "BS_VOTERS_CARD",
      },
      SV: { passport: "SV_PASSPORT", national_id: "SV_DUI" },
    })
    expect(FRAPPE_COUNTRY_BY_ISO2).toEqual({
      JM: "Jamaica",
      KY: "Cayman Islands",
      TT: "Trinidad and Tobago",
      BB: "Barbados",
      BS: "Bahamas",
      SV: "El Salvador",
    })
  })

  it.each([
    ["passport", "JM", "JM_PASSPORT"],
    ["Passport", "jm", "JM_PASSPORT"],
    ["drivers_licence", "JM", "JM_DRIVERS_LICENCE"],
    ["drivers_license", "JM", "JM_DRIVERS_LICENCE"],
    ["Driver's Licence", "JM", "JM_DRIVERS_LICENCE"],
    ["driving-licence", "KY", "KY_DRIVERS_LICENCE"],
    ["drivers_permit", "TT", "TT_DRIVERS_PERMIT"],
    ["drivers_licence", "TT", "TT_DRIVERS_PERMIT"],
    ["national_id", "JM", "JM_NIDS"],
    ["nids", "JM", "JM_NIDS"],
    ["national id card", "TT", "TT_NATIONAL_ID"],
    ["id_card", "BB", "BB_NATIONAL_ID"],
    ["dui", "SV", "SV_DUI"],
    ["national_id", "SV", "SV_DUI"],
    ["voter_id", "JM", "JM_VOTER_ID"],
    ["voters_card", "BS", "BS_VOTERS_CARD"],
    ["voter_id", "BS", "BS_VOTERS_CARD"],
    ["passport", "SV", "SV_PASSPORT"],
  ])("maps (%s, %s) → %s", (kind, country, code) => {
    expect(toIdentityDocumentTypeCode(kind, country)).toBe(code)
  })

  it.each([
    ["voter_id", "TT"], // kind not seeded for that country
    ["passport", "US"], // country not seeded
    ["passport", undefined], // kind alone is ambiguous
    ["birth_certificate", "JM"], // unknown kind
    [undefined, "JM"],
  ])("leaves (%s, %s) unmapped", (kind, country) => {
    expect(toIdentityDocumentTypeCode(kind, country)).toBeUndefined()
  })

  it("passes a registry code or Frappe country name through verbatim", () => {
    expect(toIdentityDocumentTypeCode("JM_PASSPORT", "Jamaica")).toBe("JM_PASSPORT")
    expect(toIdentityDocumentTypeCode("jm_passport")).toBe("JM_PASSPORT")
    expect(toFrappeCountry("Jamaica")).toBe("Jamaica")
    expect(toFrappeCountry("Trinidad and Tobago")).toBe("Trinidad and Tobago")
  })

  it("maps ISO-2 to the Frappe country name", () => {
    expect(toFrappeCountry("JM")).toBe("Jamaica")
    expect(toFrappeCountry(" sv ")).toBe("El Salvador")
    expect(toFrappeCountry("US")).toBeUndefined()
    expect(toFrappeCountry(undefined)).toBeUndefined()
  })

  it("writes the registry code and country name on the wire row", () => {
    const row = toErpnextRow({ documentType: "drivers_licence", issuingCountry: "JM" })
    expect(row.document_type).toBe("JM_DRIVERS_LICENCE")
    expect(row.issuing_country).toBe("Jamaica")
    expect(baseLogger.warn).not.toHaveBeenCalled()
  })

  it("omits an unmapped document_type but keeps the mapped country, and warns without PII", () => {
    const row = toErpnextRow({ documentType: "birth_certificate", issuingCountry: "JM" })
    expect(row.document_type).toBeUndefined()
    expect(row.issuing_country).toBe("Jamaica")
    expect(row.file_key).toBe("id_documents/alice/front.jpg")
    expect(baseLogger.warn).toHaveBeenCalledTimes(1)
    const [payload, message] = (baseLogger.warn as jest.Mock).mock.calls[0]
    expect(payload).toEqual({
      evidenceRow: undefined,
      evidenceType: "id_front",
      documentType: "birth_certificate",
      issuingCountry: "JM",
      mappedDocumentType: undefined,
      mappedCountry: "Jamaica",
    })
    expect(JSON.stringify(payload)).not.toContain("id_documents/alice")
    expect(JSON.stringify(payload)).not.toContain("ab".repeat(32))
    expect(message).toContain("omitting the unmapped Link field")
  })

  it("omits both Link fields for an unseeded country", () => {
    const row = toErpnextRow({ documentType: "passport", issuingCountry: "US" })
    expect(row.document_type).toBeUndefined()
    expect(row.issuing_country).toBeUndefined()
    expect(baseLogger.warn).toHaveBeenCalledTimes(1)
  })

  it("omits document_type when the kind arrives without a country", () => {
    const row = toErpnextRow({ documentType: "passport" })
    expect(row.document_type).toBeUndefined()
    expect(row.issuing_country).toBeUndefined()
    expect(baseLogger.warn).toHaveBeenCalledTimes(1)
  })

  it("stays silent when neither field is set", () => {
    const row = toErpnextRow({})
    expect(row.document_type).toBeUndefined()
    expect(row.issuing_country).toBeUndefined()
    expect(baseLogger.warn).not.toHaveBeenCalled()
  })

  it("round-trips a row read back from ERPNext unchanged", () => {
    const [row] = IdVerification.fromErpnext({
      upgrade_request: "AUR-0001",
      status: "Checks pending",
      identity_source: "capture",
      evidence: [
        {
          name: "row-1",
          evidence_type: "id_front",
          document_type: "JM_PASSPORT",
          issuing_country: "Jamaica",
          file_key: "id_documents/a/f.jpg",
        },
      ],
    }).evidence
    expect(IdVerification.evidenceRowToErpnext(row)).toEqual(
      expect.objectContaining({
        name: "row-1",
        document_type: "JM_PASSPORT",
        issuing_country: "Jamaica",
      }),
    )
    expect(baseLogger.warn).not.toHaveBeenCalled()
  })

  it("passes read-back registry values through verbatim even when absent from the local mirror", () => {
    // An operator added DO_CEDULA + Dominican Republic to the ERPNext registry
    // after this file's seed mirror was written. The retention job must not
    // strip them on its next full-table PUT.
    const [row] = IdVerification.fromErpnext({
      upgrade_request: "AUR-0001",
      status: "Checks pending",
      identity_source: "capture",
      evidence: [
        {
          name: "row-1",
          evidence_type: "id_front",
          document_type: "DO_CEDULA",
          issuing_country: "Dominican Republic",
          file_key: "id_documents/a/f.jpg",
        },
      ],
    }).evidence
    expect(toIdentityDocumentTypeCode("DO_CEDULA", "Dominican Republic")).toBeUndefined()
    expect(toFrappeCountry("Dominican Republic")).toBeUndefined()

    expect(IdVerification.evidenceRowToErpnext(row)).toEqual(
      expect.objectContaining({
        name: "row-1",
        document_type: "DO_CEDULA",
        issuing_country: "Dominican Republic",
      }),
    )
    expect(
      IdVerification.evidenceRowToErpnext({
        ...row,
        deletedAt: new Date("2033-01-01T00:00:00Z"),
      }),
    ).toEqual(
      expect.objectContaining({
        document_type: "DO_CEDULA",
        issuing_country: "Dominican Republic",
        deleted_at: "2033-01-01 00:00:00",
      }),
    )
    expect(baseLogger.warn).not.toHaveBeenCalled()
  })

  it("still maps a fresh row (no child name) through the mirror", () => {
    const row = toErpnextRow({ documentType: "passport", issuingCountry: "DO" })
    expect(row.name).toBeUndefined()
    expect(row.document_type).toBeUndefined()
    expect(row.issuing_country).toBeUndefined()
    expect(baseLogger.warn).toHaveBeenCalledTimes(1)
  })
})

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
          // Link fields carry the registry code / Frappe country name, never
          // the raw input (see "evidence link mapping" below).
          document_type: "JM_PASSPORT",
          issuing_country: "Jamaica",
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

  it("falls back an unrecognized evidence_type to id_front but logs a warning", () => {
    ;(baseLogger.warn as jest.Mock).mockClear()

    const doc = IdVerification.fromErpnext({
      name: "IDV-0002",
      upgrade_request: "AUR-0002",
      status: "Checks pending",
      identity_source: "capture",
      evidence: [
        {
          name: "row-9",
          evidence_type: "passport_scan", // not a real UpgradeEvidenceType
          file_key: "id_documents/alice/weird.jpg",
        },
      ],
    })

    expect(doc.evidence).toEqual([
      expect.objectContaining({
        rowName: "row-9",
        type: UpgradeEvidenceType.IdFront,
      }),
    ])
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        idVerification: "IDV-0002",
        upgradeRequest: "AUR-0002",
        evidenceRow: "row-9",
        rawEvidenceType: "passport_scan",
      }),
      expect.stringContaining("Unrecognized evidence_type"),
    )
  })

  it("does not warn for a recognized evidence_type", () => {
    ;(baseLogger.warn as jest.Mock).mockClear()

    IdVerification.fromErpnext({
      upgrade_request: "AUR-0003",
      status: "Checks pending",
      identity_source: "capture",
      evidence: [{ name: "row-1", evidence_type: "selfie" }],
    })

    expect(baseLogger.warn).not.toHaveBeenCalled()
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
