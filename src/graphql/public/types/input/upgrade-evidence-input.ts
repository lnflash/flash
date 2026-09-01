import { GT } from "@graphql/index"
import { UpgradeEvidenceType as DomainUpgradeEvidenceType } from "@domain/accounts"

export const UpgradeEvidenceType = GT.Enum({
  name: "UpgradeEvidenceType",
  values: {
    ID_FRONT: { value: DomainUpgradeEvidenceType.IdFront },
    ID_BACK: { value: DomainUpgradeEvidenceType.IdBack },
    SELFIE: { value: DomainUpgradeEvidenceType.Selfie },
    LIVENESS_FRAME: { value: DomainUpgradeEvidenceType.LivenessFrame },
    BUSINESS_REGISTRATION: { value: DomainUpgradeEvidenceType.BusinessRegistration },
    TRN: { value: DomainUpgradeEvidenceType.Trn },
    PROOF_OF_ADDRESS: { value: DomainUpgradeEvidenceType.ProofOfAddress },
    BRIDGE_KYC: {
      value: DomainUpgradeEvidenceType.BridgeKyc,
      description:
        "Identity established by the account's approved Bridge KYC; carries no file.",
    },
  },
})

const UpgradeEvidenceInput = GT.Input({
  name: "UpgradeEvidenceInput",
  fields: () => ({
    type: { type: GT.NonNull(UpgradeEvidenceType) },
    fileKey: {
      type: GT.String,
      description:
        "Storage key returned by idDocumentUploadUrlGenerate. Required for every type except BRIDGE_KYC.",
    },
    sha256: {
      type: GT.String,
      description: "Hex SHA-256 of the uploaded file, computed client-side.",
    },
    documentType: {
      type: GT.String,
      description:
        "Free-form document kind, e.g. passport, drivers_licence, national_id.",
    },
    issuingCountry: {
      type: GT.String,
      description: "ISO 3166-1 alpha-2 country that issued the document.",
    },
  }),
})

export default UpgradeEvidenceInput
