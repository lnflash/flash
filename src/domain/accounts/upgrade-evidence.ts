import { ValidationError } from "@domain/shared"

import { AccountLevel } from "./primitives"

// Phase 0 of the ID-verification tool (docs/id-verification.md).
//
// An upgrade request carries a list of *evidence* rows — the files a user
// captured (ID front/back, selfie, ...) or a pointer at an external identity
// check (Bridge KYC). This module is pure: it normalizes the legacy single
// `idDocument` key into an evidence row, and validates a list against the
// requested level. Strictness is a caller-supplied flag so the current mobile
// app (which only sends `idDocument`) keeps working until the capture flow
// ships.

export const UpgradeEvidenceType = {
  IdFront: "id_front",
  IdBack: "id_back",
  Selfie: "selfie",
  LivenessFrame: "liveness_frame",
  BusinessRegistration: "business_registration",
  Trn: "trn",
  ProofOfAddress: "proof_of_address",
  BridgeKyc: "bridge_kyc",
} as const

export type UpgradeEvidenceType =
  (typeof UpgradeEvidenceType)[keyof typeof UpgradeEvidenceType]

export const UPGRADE_EVIDENCE_TYPES: readonly UpgradeEvidenceType[] =
  Object.values(UpgradeEvidenceType)

export const isUpgradeEvidenceType = (value: unknown): value is UpgradeEvidenceType =>
  typeof value === "string" &&
  (UPGRADE_EVIDENCE_TYPES as readonly string[]).includes(value)

// Where the storage service puts every ID document (services/storage):
// `id_documents/<username>_<filename>`.
export const ID_DOCUMENTS_PREFIX = "id_documents/"

export const idDocumentKeyPrefixForUsername = (username: string) =>
  `${ID_DOCUMENTS_PREFIX}${username}_`

export type UpgradeEvidenceInput = {
  type: UpgradeEvidenceType
  fileKey?: string | null
  sha256?: string | null
  documentType?: string | null
  issuingCountry?: string | null
}

export type UpgradeEvidence = {
  type: UpgradeEvidenceType
  fileKey?: string
  sha256?: string
  documentType?: string
  issuingCountry?: string
  // True for the row synthesized from the pre-evidence `idDocument` field.
  // That field has never been validated, so the legacy row is only held to
  // the file-key rules in strict mode ("keep idDocument working as today").
  legacy?: boolean
}

export const IdentitySource = {
  BridgeKyc: "bridge_kyc",
  Capture: "capture",
} as const

export type IdentitySource = (typeof IdentitySource)[keyof typeof IdentitySource]

const SHA256_HEX = /^[0-9a-f]{64}$/i

const clean = (value?: string | null): string | undefined => {
  if (value === undefined || value === null) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

// Merge the structured `evidence` list with the legacy `idDocument` key. The
// legacy key becomes one ID_FRONT row unless the list already carries a row
// with the same file key. Rows are copied and trimmed; nothing is validated
// here.
export const normalizeEvidence = ({
  evidence,
  idDocument,
}: {
  evidence?: UpgradeEvidenceInput[] | null
  idDocument?: string | null
}): UpgradeEvidence[] => {
  const rows: UpgradeEvidence[] = (evidence ?? []).map((row) => ({
    type: row.type,
    fileKey: clean(row.fileKey),
    sha256: clean(row.sha256)?.toLowerCase(),
    documentType: clean(row.documentType),
    issuingCountry: clean(row.issuingCountry)?.toUpperCase(),
  }))

  const legacyKey = clean(idDocument)
  if (legacyKey && !rows.some((row) => row.fileKey === legacyKey)) {
    rows.push({ type: UpgradeEvidenceType.IdFront, fileKey: legacyKey, legacy: true })
  }

  return rows
}

// An account whose Bridge KYC is approved and that submitted no evidence at
// all is identified through Bridge: add the BRIDGE_KYC row so the request
// records that source. A non-empty list is left alone.
export const applyBridgeKycFallback = ({
  evidence,
  bridgeKycApproved,
}: {
  evidence: UpgradeEvidence[]
  bridgeKycApproved: boolean
}): UpgradeEvidence[] => {
  if (evidence.length > 0 || !bridgeKycApproved) return evidence
  return [{ type: UpgradeEvidenceType.BridgeKyc }]
}

export const hasEvidenceOfType = (
  evidence: UpgradeEvidence[],
  type: UpgradeEvidenceType,
) => evidence.some((row) => row.type === type)

// The key that goes into the legacy `id_document` ERPNext field: the first
// ID_FRONT file. Keeps the existing reviewer screen and the public
// `accountUpgradeRequest.idDocument: Boolean` resolver working unchanged.
export const legacyIdDocumentKey = (evidence: UpgradeEvidence[]): string =>
  evidence.find((row) => row.type === UpgradeEvidenceType.IdFront && row.fileKey)
    ?.fileKey ?? ""

export const identitySourceFor = ({
  evidence,
  bridgeKycApproved,
}: {
  evidence: UpgradeEvidence[]
  bridgeKycApproved: boolean
}): IdentitySource =>
  bridgeKycApproved && hasEvidenceOfType(evidence, UpgradeEvidenceType.BridgeKyc)
    ? IdentitySource.BridgeKyc
    : IdentitySource.Capture

const requiresIdentityEvidence = (level: AccountLevel) => level >= AccountLevel.Two

export const validateEvidence = ({
  evidence,
  level,
  username,
  bridgeKycApproved,
  strict,
}: {
  evidence: UpgradeEvidence[]
  level: AccountLevel
  username: string
  bridgeKycApproved: boolean
  strict: boolean
}): true | ValidationError => {
  const ownPrefix = idDocumentKeyPrefixForUsername(username)

  for (const row of evidence) {
    if (!isUpgradeEvidenceType(row.type)) {
      return new ValidationError(`Unknown evidence type: ${String(row.type)}`)
    }

    if (row.type === UpgradeEvidenceType.BridgeKyc) {
      if (!bridgeKycApproved) {
        return new ValidationError(
          "Bridge KYC evidence requires an approved Bridge KYC on the account",
        )
      }
      continue
    }

    // Capture rows point at a file. The legacy idDocument row is exempt from
    // the key rules outside strict mode — that field has never been checked
    // and the current app must keep working.
    const enforceKeyRules = strict || !row.legacy
    if (!row.fileKey) {
      if (enforceKeyRules) {
        return new ValidationError(`Evidence ${row.type} is missing its file key`)
      }
      continue
    }
    if (enforceKeyRules && !row.fileKey.startsWith(ownPrefix)) {
      return new ValidationError(
        `Evidence ${row.type} file key must be an ID document uploaded by this account`,
      )
    }
    if (row.sha256 !== undefined && !SHA256_HEX.test(row.sha256)) {
      return new ValidationError(`Evidence ${row.type} sha256 must be 64 hex characters`)
    }
  }

  if (strict && requiresIdentityEvidence(level)) {
    const captured =
      hasEvidenceOfType(evidence, UpgradeEvidenceType.IdFront) &&
      hasEvidenceOfType(evidence, UpgradeEvidenceType.Selfie)
    const viaBridge =
      bridgeKycApproved && hasEvidenceOfType(evidence, UpgradeEvidenceType.BridgeKyc)
    if (!captured && !viaBridge) {
      return new ValidationError(
        "Identity evidence required: an ID front and a selfie, or an approved Bridge KYC",
      )
    }
  }

  return true
}
