import { UPGRADE_EVIDENCE_STRICT } from "@config"
import {
  BRIDGE_KYC_APPROVED,
  IdentitySource,
  UpgradeEvidence,
  UpgradeEvidenceInput,
  UpgradeEvidenceType,
  applyBridgeKycFallback,
  hasEvidenceOfType,
  identitySourceFor,
  normalizeEvidence,
  validateEvidence,
} from "@domain/accounts"
import { ValidationError } from "@domain/shared"
import { baseLogger } from "@services/logger"
import ErpNext from "@services/frappe/ErpNext"
import { IdVerification } from "@services/frappe/models/IdVerification"
import {
  BridgeCustomerSnapshot,
  snapshotBridgeCustomer,
} from "@services/bridge/customer-snapshot"

// Evidence half of createUpgradeRequest (docs/id-verification.md).

export type PreparedEvidence = {
  evidence: UpgradeEvidence[]
  bridgeKycApproved: boolean
}

export const isBridgeKycApproved = (account: Pick<Account, "bridgeKycStatus">) =>
  account.bridgeKycStatus === BRIDGE_KYC_APPROVED

// Normalize + validate the evidence for a request. `strict` defaults to the
// UPGRADE_EVIDENCE_STRICT flag.
export const prepareUpgradeEvidence = ({
  account,
  level,
  evidence,
  idDocument,
  strict = UPGRADE_EVIDENCE_STRICT,
}: {
  account: Pick<Account, "username" | "bridgeKycStatus">
  level: AccountLevel
  evidence?: UpgradeEvidenceInput[] | null
  idDocument?: string | null
  strict?: boolean
}): PreparedEvidence | ValidationError => {
  const bridgeKycApproved = isBridgeKycApproved(account)
  const rows = applyBridgeKycFallback({
    evidence: normalizeEvidence({ evidence, idDocument }),
    bridgeKycApproved,
  })

  const check = validateEvidence({
    evidence: rows,
    level,
    username: account.username ?? "",
    bridgeKycApproved,
    strict,
  })
  if (check instanceof Error) return check

  return { evidence: rows, bridgeKycApproved }
}

// Snapshot the Bridge customer when Bridge KYC is (part of) the identity
// source. Never blocks the request.
export const maybeSnapshotBridgeCustomer = async ({
  account,
  evidence,
  bridgeKycApproved,
}: {
  account: Pick<Account, "bridgeCustomerId">
  evidence: UpgradeEvidence[]
  bridgeKycApproved: boolean
}): Promise<BridgeCustomerSnapshot | undefined> => {
  if (!bridgeKycApproved || !account.bridgeCustomerId) return undefined
  if (!hasEvidenceOfType(evidence, UpgradeEvidenceType.BridgeKyc)) return undefined
  return snapshotBridgeCustomer({ bridgeCustomerId: account.bridgeCustomerId })
}

// Write the companion ID Verification document. Non-fatal by design: an
// older ERPNext without the doctype, or a transient failure, must not fail
// the user's upgrade request — the legacy id_document field on the Account
// Upgrade Request still carries the first ID_FRONT key.
export const recordIdVerification = async ({
  upgradeRequestName,
  account,
  evidence,
  bridgeKycApproved,
  bridgeSnapshot,
}: {
  upgradeRequestName: string
  account: Pick<Account, "id" | "bridgeCustomerId">
  evidence: UpgradeEvidence[]
  bridgeKycApproved: boolean
  bridgeSnapshot?: BridgeCustomerSnapshot
}): Promise<{ name: string } | undefined> => {
  const identitySource = identitySourceFor({ evidence, bridgeKycApproved })
  const doc = IdVerification.fromEvidence({
    upgradeRequest: upgradeRequestName,
    evidence,
    identitySource,
    bridgeCustomerId:
      identitySource === IdentitySource.BridgeKyc
        ? (bridgeSnapshot?.id ?? account.bridgeCustomerId)
        : undefined,
    bridgeSnapshot,
  })

  if (!ErpNext) {
    baseLogger.warn(
      { upgradeRequestName },
      "ERPNext not configured; ID Verification not recorded",
    )
    return undefined
  }

  const result = await ErpNext.postIdVerification(doc)
  if (result instanceof Error) {
    baseLogger.warn(
      {
        upgradeRequestName,
        accountId: account.id,
        identitySource,
        evidenceCount: evidence.length,
        error: result.message,
      },
      "ID Verification not recorded for upgrade request; continuing",
    )
    return undefined
  }
  return result
}
