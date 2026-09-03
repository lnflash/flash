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

export const IdVerificationStatus = {
  ChecksPending: "Checks pending",
} as const

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
    return {
      name: row.rowName,
      evidence_type: row.type,
      document_type: row.documentType,
      issuing_country: row.issuingCountry,
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
