import {
  IdentitySource,
  UpgradeEvidence,
  UpgradeEvidenceType,
  isUpgradeEvidenceType,
} from "@domain/accounts"
import { baseLogger } from "@services/logger"

import { toFrappeDatetime } from "./BridgeTransferRequest"

// Companion of "Account Upgrade Request": the identity checks and evidence
// files behind one upgrade request (docs/id-verification.md, "ERPNext wire").
// Written once after the upgrade request is created; the retention job later
// stamps `deleted_at` on evidence rows whose files it removed.

// Mirrors the `status` Select on the ID Verification doctype.
export const IdVerificationStatus = {
  ChecksPending: "Checks pending",
  ReadyForReview: "Ready for review",
  ChecksUnavailable: "Checks unavailable",
  Approved: "Approved",
  Rejected: "Rejected",
  ResubmitRequested: "Resubmit requested",
} as const
export type IdVerificationStatus =
  (typeof IdVerificationStatus)[keyof typeof IdVerificationStatus]

// The review-state slice of an ID Verification, as read by the status query.
// `reviewer_note` is internal and must never reach a customer, so it is not
// requested from ERPNext at all: this object feeds the public resolver.
export type IdVerificationSummary = {
  name: string
  status: string
  decision_reason?: string
  reviewed_at?: string
}

export type DecisionReasonDoc = {
  code: string
  outcome: string
  label: string
  user_facing_message: string
}

export type BridgeCustomerSnapshot = {
  id: string
  status?: string
  updated_at?: string
  endorsements?: unknown[]
}

export type ErpNextIdVerificationEvidenceRow = {
  // Child-row id, present on rows read back from ERPNext.
  name?: string
  evidence_type: string
  document_type?: string
  issuing_country?: string
  file_key?: string
  sha256?: string
  content_type?: string
  captured_at?: string
  deleted_at?: string | null
}

export type ErpNextIdVerificationDoc = {
  doctype?: string
  name?: string
  upgrade_request: string
  status: string
  identity_source: string
  bridge_customer_id?: string
  bridge_snapshot_json?: string
  evidence?: ErpNextIdVerificationEvidenceRow[]
}

export type IdVerificationEvidenceRow = {
  rowName?: string
  type: UpgradeEvidenceType
  documentType?: string
  issuingCountry?: string
  fileKey?: string
  sha256?: string
  contentType?: string
  capturedAt?: Date
  deletedAt?: Date
}

// ---- Evidence link mapping ------------------------------------------------
//
// `Verification Evidence.document_type` is a Link to `Identity Document Type`
// and `issuing_country` a Link to `Country`. The GraphQL input carries a
// free-form kind ("passport", "drivers_licence") and an ISO-2 code ("JM"), so
// they must be translated to the registry code / Frappe country name or the
// whole ID Verification insert fails link validation. The tables below are
// the registry seeded by frappe-flash-admin `admin_panel/setup.py`
// (IDENTITY_DOCUMENT_TYPES); an unmapped value omits the Link field rather
// than sending something Frappe would reject.

// ISO 3166-1 alpha-2 → Frappe `Country` document name, for every country the
// registry seeds. Jamaica first: it is the only market with three kinds.
export const FRAPPE_COUNTRY_BY_ISO2: Readonly<Record<string, string>> = {
  JM: "Jamaica",
  KY: "Cayman Islands",
  TT: "Trinidad and Tobago",
  BB: "Barbados",
  BS: "Bahamas",
  SV: "El Salvador",
}

// Canonical document kinds, the keys of the per-country tables below.
const DocumentKind = {
  Passport: "passport",
  DriversLicence: "drivers_licence",
  NationalId: "national_id",
  VoterId: "voter_id",
} as const
type DocumentKind = (typeof DocumentKind)[keyof typeof DocumentKind]

// ISO-2 → kind → `Identity Document Type.code`. Mirrors setup.py exactly:
// one entry per seeded row, including rows the registry ships disabled (the
// registry's `enabled` flag is the operator's call, not ours).
export const IDENTITY_DOCUMENT_TYPE_CODES: Readonly<
  Record<string, Readonly<Partial<Record<DocumentKind, string>>>>
> = {
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
}

const KNOWN_DOCUMENT_TYPE_CODES: ReadonlySet<string> = new Set(
  Object.values(IDENTITY_DOCUMENT_TYPE_CODES).flatMap((byKind) => Object.values(byKind)),
)

const KNOWN_FRAPPE_COUNTRIES: ReadonlySet<string> = new Set(
  Object.values(FRAPPE_COUNTRY_BY_ISO2),
)

// Free-form kind → canonical kind. Keys are the normalized form (lowercase,
// apostrophes dropped, runs of non-alphanumerics collapsed to "_").
const DOCUMENT_KIND_ALIASES: Readonly<Record<string, DocumentKind>> = {
  passport: DocumentKind.Passport,
  drivers_licence: DocumentKind.DriversLicence,
  drivers_license: DocumentKind.DriversLicence,
  driver_licence: DocumentKind.DriversLicence,
  driver_license: DocumentKind.DriversLicence,
  driving_licence: DocumentKind.DriversLicence,
  driving_license: DocumentKind.DriversLicence,
  drivers_permit: DocumentKind.DriversLicence,
  driver_permit: DocumentKind.DriversLicence,
  national_id: DocumentKind.NationalId,
  national_id_card: DocumentKind.NationalId,
  id_card: DocumentKind.NationalId,
  nids: DocumentKind.NationalId,
  dui: DocumentKind.NationalId,
  voter_id: DocumentKind.VoterId,
  voters_id: DocumentKind.VoterId,
  voter_card: DocumentKind.VoterId,
  voters_card: DocumentKind.VoterId,
  voter_id_card: DocumentKind.VoterId,
}

const normalizeKind = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")

// ISO-2 or an already-mapped Frappe country name → Frappe country name.
// Accepting the Frappe name lets rows read back from ERPNext (retention job)
// round-trip through evidenceRowToErpnext unchanged.
export const toFrappeCountry = (issuingCountry?: string): string | undefined => {
  if (!issuingCountry) return undefined
  const trimmed = issuingCountry.trim()
  if (KNOWN_FRAPPE_COUNTRIES.has(trimmed)) return trimmed
  return FRAPPE_COUNTRY_BY_ISO2[trimmed.toUpperCase()]
}

// (kind, ISO-2) or an already-mapped registry code → `Identity Document
// Type.code`. Without a mappable country the kind alone is ambiguous, so
// only a verbatim registry code maps.
export const toIdentityDocumentTypeCode = (
  documentType?: string,
  issuingCountry?: string,
): string | undefined => {
  if (!documentType) return undefined
  const trimmed = documentType.trim()
  if (KNOWN_DOCUMENT_TYPE_CODES.has(trimmed.toUpperCase())) return trimmed.toUpperCase()

  const kind = DOCUMENT_KIND_ALIASES[normalizeKind(trimmed)]
  if (!kind) return undefined
  const iso2 = issuingCountry?.trim().toUpperCase()
  if (!iso2) return undefined
  return IDENTITY_DOCUMENT_TYPE_CODES[iso2]?.[kind]
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
}

// The upload flow accepts only image/jpeg, image/png and image/webp and keeps
// the client's filename in the key, so the extension is a reliable source.
export const contentTypeFromFileKey = (fileKey?: string): string | undefined => {
  if (!fileKey) return undefined
  const match = /\.([A-Za-z0-9]+)$/.exec(fileKey)
  return match ? CONTENT_TYPE_BY_EXTENSION[match[1].toLowerCase()] : undefined
}

// Frappe datetimes are naive "YYYY-MM-DD HH:mm:ss[.ffffff]". We write them in
// UTC (toFrappeDatetime) and read them back the same way.
export const fromFrappeDatetime = (value?: string | null): Date | undefined => {
  if (!value) return undefined
  const iso = value.trim().replace(" ", "T")
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export class IdVerification {
  static doctype = "ID Verification"

  readonly name: string
  readonly upgradeRequest: string
  readonly status: string
  readonly identitySource: IdentitySource
  readonly bridgeCustomerId?: string
  readonly bridgeSnapshot?: BridgeCustomerSnapshot
  readonly evidence: IdVerificationEvidenceRow[]

  constructor(input: {
    name?: string
    upgradeRequest: string
    status?: string
    identitySource: IdentitySource
    bridgeCustomerId?: string
    bridgeSnapshot?: BridgeCustomerSnapshot
    evidence: IdVerificationEvidenceRow[]
  }) {
    this.name = input.name ?? ""
    this.upgradeRequest = input.upgradeRequest
    this.status = input.status ?? IdVerificationStatus.ChecksPending
    this.identitySource = input.identitySource
    this.bridgeCustomerId = input.bridgeCustomerId
    this.bridgeSnapshot = input.bridgeSnapshot
    this.evidence = input.evidence
  }

  // Build the record for a freshly created upgrade request.
  static fromEvidence({
    upgradeRequest,
    evidence,
    identitySource,
    bridgeCustomerId,
    bridgeSnapshot,
    capturedAt = new Date(),
  }: {
    upgradeRequest: string
    evidence: UpgradeEvidence[]
    identitySource: IdentitySource
    bridgeCustomerId?: string
    bridgeSnapshot?: BridgeCustomerSnapshot
    capturedAt?: Date
  }): IdVerification {
    return new IdVerification({
      upgradeRequest,
      identitySource,
      bridgeCustomerId,
      bridgeSnapshot,
      evidence: evidence.map((row) => ({
        type: row.type,
        documentType: row.documentType,
        issuingCountry: row.issuingCountry,
        fileKey: row.fileKey,
        sha256: row.sha256,
        contentType: contentTypeFromFileKey(row.fileKey),
        capturedAt,
      })),
    })
  }

  static evidenceRowToErpnext(
    row: IdVerificationEvidenceRow,
  ): ErpNextIdVerificationEvidenceRow {
    // A row read back from ERPNext (`rowName` set, via fromErpnext) already
    // carries registry values ERPNext accepted. The registry is operator-owned
    // and the table below is only a mirror of the seed, so re-translating a
    // read-back row would silently drop any entry added since (the retention
    // job PUTs the full evidence table). Only fresh rows from fromEvidence
    // carry (kind, ISO-2) and need mapping.
    const readBack = Boolean(row.rowName)
    const documentTypeCode = readBack
      ? row.documentType
      : toIdentityDocumentTypeCode(row.documentType, row.issuingCountry)
    const country = readBack ? row.issuingCountry : toFrappeCountry(row.issuingCountry)
    if ((row.documentType && !documentTypeCode) || (row.issuingCountry && !country)) {
      // Kind and country are not PII; the file key and hash are left out.
      baseLogger.warn(
        {
          evidenceRow: row.rowName,
          evidenceType: row.type,
          documentType: row.documentType,
          issuingCountry: row.issuingCountry,
          mappedDocumentType: documentTypeCode,
          mappedCountry: country,
        },
        "Evidence document type or issuing country has no ERPNext registry entry; omitting the unmapped Link field",
      )
    }
    return {
      name: row.rowName,
      evidence_type: row.type,
      document_type: documentTypeCode,
      issuing_country: country,
      file_key: row.fileKey,
      sha256: row.sha256,
      content_type: row.contentType,
      captured_at: row.capturedAt
        ? toFrappeDatetime(row.capturedAt.toISOString())
        : undefined,
      deleted_at: row.deletedAt
        ? toFrappeDatetime(row.deletedAt.toISOString())
        : undefined,
    }
  }

  toErpnext(): ErpNextIdVerificationDoc {
    return {
      doctype: IdVerification.doctype,
      upgrade_request: this.upgradeRequest,
      status: this.status,
      identity_source: this.identitySource,
      bridge_customer_id: this.bridgeCustomerId,
      bridge_snapshot_json: this.bridgeSnapshot
        ? JSON.stringify(this.bridgeSnapshot)
        : undefined,
      evidence: this.evidence.map(IdVerification.evidenceRowToErpnext),
    }
  }

  static fromErpnext(data: ErpNextIdVerificationDoc): IdVerification {
    let bridgeSnapshot: BridgeCustomerSnapshot | undefined
    if (data.bridge_snapshot_json) {
      try {
        bridgeSnapshot = JSON.parse(data.bridge_snapshot_json)
      } catch {
        bridgeSnapshot = undefined
      }
    }

    return new IdVerification({
      name: data.name,
      upgradeRequest: data.upgrade_request,
      status: data.status,
      identitySource:
        data.identity_source === IdentitySource.BridgeKyc
          ? IdentitySource.BridgeKyc
          : IdentitySource.Capture,
      bridgeCustomerId: data.bridge_customer_id || undefined,
      bridgeSnapshot,
      evidence: (data.evidence ?? []).map((row) => {
        if (!isUpgradeEvidenceType(row.evidence_type)) {
          baseLogger.warn(
            {
              idVerification: data.name,
              upgradeRequest: data.upgrade_request,
              evidenceRow: row.name,
              rawEvidenceType: row.evidence_type,
            },
            "Unrecognized evidence_type on an ID Verification row; falling back to id_front",
          )
        }
        return {
          rowName: row.name,
          type: isUpgradeEvidenceType(row.evidence_type)
            ? row.evidence_type
            : UpgradeEvidenceType.IdFront,
          documentType: row.document_type || undefined,
          issuingCountry: row.issuing_country || undefined,
          fileKey: row.file_key || undefined,
          sha256: row.sha256 || undefined,
          contentType: row.content_type || undefined,
          capturedAt: fromFrappeDatetime(row.captured_at),
          deletedAt: fromFrappeDatetime(row.deleted_at),
        }
      }),
    })
  }
}
